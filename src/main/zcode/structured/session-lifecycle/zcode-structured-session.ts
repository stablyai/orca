import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import type { StructuredAgentSessionProviderOpenResult } from '../../../native-chat/agent-session-wire/startup/structured-agent-session-provider-open-contract'
import type { AgentSessionIdleConfirmation } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { AgentSessionSlashCommand } from '../../../../shared/agent-session/agent-session-wire'
import type { ZcodeAppServerConnection } from '../../app-server/zcode-app-server-connection-types'
import { ZcodeAppServerUnsupportedError } from '../../app-server/zcode-app-server-errors'
import { createZcodeAppServerCapabilityCache } from '../../app-server/zcode-app-server-capability-cache'
import { readRecord, readString } from '../catalog/zcode-model-catalog-rows'
import { requestZcodeSkillCatalog } from '../catalog/zcode-skill-catalog'
import type { ZcodeStructuredLane } from '../timeline/zcode-structured-lane'
import { ZcodeStructuredOptions } from '../options/zcode-structured-options'
import { ZcodeStructuredPrompts } from '../prompts/zcode-structured-prompts'
import { ZcodeStructuredTurns } from '../turns/zcode-structured-turns'
import { openZcodeSession } from './zcode-structured-session-open'
import { ZcodeRuntimeHeadersAsks } from './zcode-runtime-headers-ask'
import type { ZcodeStructuredSessionDeps } from './zcode-structured-session-state'

// One zcode app-server child serving one Orca chat. Frames arrive from the spawn handlers; the
// handshake (runtime preferences, account push, create/resume, subscribe) happens in `open`.

export class ZcodeStructuredSession {
  readonly options = new ZcodeStructuredOptions()
  readonly prompts: ZcodeStructuredPrompts
  readonly turns: ZcodeStructuredTurns
  lane: ZcodeStructuredLane | null = null
  providerSessionId: string | null = null
  /** The account push ran with credentials during acquire; open skips repeating it. */
  accountPushed = false
  /** The model ids the account push declared; the backend lists only the live selection. */
  declaredModels: readonly { providerId: string; modelId: string }[] = []
  /** The turn id and routed model of the last seen headers ask, for one notice per real switch. */
  private readonly headersAsks = new ZcodeRuntimeHeadersAsks()
  private readonly capabilities = createZcodeAppServerCapabilityCache()
  /** The live child's `/` skills, probed once after open; undefined keeps the client catalog. */
  commands: AgentSessionSlashCommand[] | undefined = undefined
  /** A dispatch is between admission and its write; Stop and restarts treat it as held. */
  dispatchPending = false
  readonly acquisitionGeneration: string
  closeRequested = false
  failureClose: string | null = null
  journalClosed: string | null = null
  ended = false
  exitObservedAt: number | null = null
  /** Compaction command awaiting its `session_compact_*` outcome. */
  private compactionTurnId: string | null = null
  /** Undoes the journal-backpressure → provider-reader coupling installed at open. */
  readingUnbind: (() => void) | null = null
  private readonly early: (() => void)[] = []

  constructor(
    readonly connection: ZcodeAppServerConnection,
    readonly deps: ZcodeStructuredSessionDeps,
    private readonly sink: StructuredAgentSessionEventSink
  ) {
    this.acquisitionGeneration = deps.generation
    this.prompts = new ZcodeStructuredPrompts({
      lane: () => this.lane,
      admits: () => this.acceptsRequests(),
      respond: (frameId, reply) => connection.respond(frameId, reply)
    })
    this.turns = new ZcodeStructuredTurns({
      connection: () => connection,
      lane: () => this.lane,
      translator: () => this.lane?.translator ?? null,
      agentName: 'ZCode',
      now: deps.now,
      settle: (settlement) => deps.onSettled(settlement)
    })
  }

  private acceptsRequests(): boolean {
    return !this.ended && this.journalClosed === null && !this.closeRequested
  }

  /** Routes one connection notification. */
  onNotification(method: string, params: unknown): void {
    this.whenLane(() => {
      const lane = this.lane
      if (!lane) {
        return
      }
      if (method === 'session/event') {
        const record = readRecord(params)
        const type = readString(record?.type)
        if (!type) {
          return
        }
        if (type === 'session.updated') {
          const payload = readRecord(record?.payload)
          const usage = lane.translator.contextUsage(
            payload?.usage,
            payload?.contextWindow,
            this.deps.now()
          )
          if (usage.length > 0) {
            lane.apply(usage)
          }
        }
        lane.apply(lane.translator.sessionEvent(type, record?.payload, this.deps.now()))
        return
      }
      if (method === 'state.updated') {
        this.onStateUpdated(params)
        return
      }
      // Telemetry, process samples and hook descriptors are bookkeeping, never chat rows.
      lane.apply(lane.translator.frame(method, params))
    })
  }

  private onStateUpdated(params: unknown): void {
    const record = readRecord(params)
    const patch = readRecord(record?.patch)
    const reason = readString(record?.reason) ?? ''
    if (patch?.model) {
      this.options.adoptAvailability(
        readRecord(patch.model)?.available,
        readRecord(patch.model)?.current
      )
      // Selection reports drift from what actually routes, so the switch notice reads only the
      // outgoing headers ask; this push never touches the notice's last-known model.
      this.publishOptions()
    }
    if (patch?.mode) {
      this.options.adoptMode(readRecord(patch.mode)?.current)
      // Mode-only pushes also change the permission/interaction read; republish without a model.
      this.publishOptions()
    }
    if (this.compactionTurnId && reason.startsWith('session_compact_')) {
      const turnId = this.compactionTurnId
      this.compactionTurnId = null
      this.whenLane(() => {
        this.lane?.apply([
          {
            type: 'turn.end',
            turn: turnId,
            at: this.deps.now(),
            state: 'completed',
            outcome: 'success'
          }
        ])
      })
    }
  }

  /** Routes one server→client request and answers bookkeeping asks directly. */
  onServerRequest(method: string, params: unknown, id: number | string): void {
    if (method === 'session/requestRuntimePreferences') {
      this.connection.respond(id, {
        nativeSearchEnhancementsEnabled: false,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: false
      })
      return
    }
    if (method === 'interaction/requestProviderRuntimeHeaders') {
      this.headersAsks.answer({
        connection: this.connection,
        params,
        id,
        credentials: this.deps.credentials,
        options: this.options,
        lane: this.lane,
        providerSessionId: this.providerSessionId,
        now: this.deps.now
      })
      return
    }
    if (method === 'interaction/requestOfficialMcpAuthHeaders') {
      this.connection.respondWithError(id, -32000, 'official MCP auth is unavailable in Orca chats')
      return
    }
    if (method === 'interaction/requestPermission' || method === 'interaction/requestUserInput') {
      // handle can throw synchronously (unsupported shape); deferring keeps that throw inside
      // the promise so the provider still receives the error reply.
      void Promise.resolve()
        .then(() => this.prompts.handle(method, params, id))
        .catch((error: unknown) => {
          this.deps.logger?.warn('zcode interaction could not be answered', {
            scope: 'zcode-interaction',
            method,
            error
          })
          this.connection.respondWithError(id, -32603, String(error))
        })
      return
    }
    this.deps.logger?.warn('zcode app-server sent an unknown request', {
      scope: 'zcode-request-unknown',
      method
    })
    this.connection.respondWithError(id, -32601, `Orca does not answer ${method}`)
  }

  /** The open handshake lives in zcode-structured-session-open.ts. */
  open(signal: AbortSignal): Promise<StructuredAgentSessionProviderOpenResult> {
    return openZcodeSession(this, signal)
  }

  sinkForOpen(): StructuredAgentSessionEventSink {
    return this.sink
  }

  adoptSnapshotContextWindow(window: number): void {
    this.whenLane(() => {
      this.lane?.apply(this.lane!.translator.contextUsage(null, window, this.deps.now()))
    })
  }

  /** Store the account push's declared models and seed the picker with them. */
  declareModels(models: readonly { providerId: string; modelId: string }[]): void {
    this.declaredModels = models
    this.options.adoptDeclaredModels(models)
  }

  /** Re-seed with the snapshot's own level menu once it arrives. */
  adoptDeclaredModelLevels(levels?: readonly { value: string; label: string }[]): void {
    this.options.adoptDeclaredModels(this.declaredModels, levels)
  }

  publishOptionsFromOpen(): void {
    this.publishOptions()
  }

  /** Writes one option through the session, journaling a model switch the fold never hides. */
  async setOption(
    key: string,
    value: string,
    timeoutMs: number | null
  ): Promise<Record<string, string>> {
    const providerSessionId = this.providerSessionId
    if (!providerSessionId) {
      throw new Error('zcode session is not open yet')
    }
    const result = await this.options.write(
      this.connection,
      providerSessionId,
      key,
      value,
      timeoutMs
    )
    return result
  }

  private publishOptions(): void {
    this.deps.onEvent({
      type: 'options-reported',
      sessionId: this.deps.acquire.identity.sessionId,
      fence: this.deps.acquire.fence,
      acquisitionGeneration: this.deps.generation,
      reportedOptions: this.options.live(null).current
    })
  }

  /** Frames that arrived before the lane existed replay once it exists. */
  private whenLane(deliver: () => void): void {
    if (this.lane) {
      deliver()
    } else if (this.early.length < 2048) {
      this.early.push(deliver)
    }
  }

  /** Replays buffered frames after open creates the lane; later frames deliver directly. */
  drainEarly(): void {
    for (const deliver of this.early.splice(0)) {
      deliver()
    }
  }

  markJournalClosed(reason: string): void {
    this.journalClosed ??= reason
  }

  /** Names the provider turn a running `/compact` command fills once its outcome lands. */
  startCompaction(turnId: string): void {
    this.compactionTurnId = turnId
  }
  cancelCompaction(): void {
    this.compactionTurnId = null
  }

  /** Probe the live child's skill catalog once; an unsupported method keeps the client catalog. */
  probeCommands(): void {
    const providerSessionId = this.providerSessionId
    if (this.commands !== undefined || !providerSessionId) {
      return
    }
    void this.capabilities
      .runWithFallback(
        'skills/referenceCatalog',
        () =>
          requestZcodeSkillCatalog(
            this.connection,
            {
              workspace: {
                workspacePath: this.deps.launch.cwd,
                workspaceKey: this.deps.launch.cwd
              },
              sessionId: providerSessionId
            },
            this.deps.requestTimeoutMs
          ),
        async () => null,
        (error) => error instanceof ZcodeAppServerUnsupportedError
      )
      .then((commands) => {
        if (commands !== null) {
          this.commands = commands
        }
      })
      .catch(() => undefined)
  }

  /** Fresh idle verdict for the host's sweep: held sends and open prompts keep the child. */
  idleConfirmation(): AgentSessionIdleConfirmation {
    return this.turns.heldSends.size > 0 || this.prompts.size > 0 ? 'busy' : 'idle'
  }

  /** Claim this input's still-unsettled send; its echo or teardown ends the pending window. */
  armPendingOutput(input: {
    clientMessageId: string
    fence: number
    generation: string
  }): (() => boolean) | undefined {
    if (
      this.ended ||
      this.deps.acquire.fence !== input.fence ||
      this.acquisitionGeneration !== input.generation
    ) {
      return undefined
    }
    return () => this.journalClosed === null && this.turns.heldSends.has(input.clientMessageId)
  }

  markEnded(observedAt: number): void {
    this.ended = true
    this.exitObservedAt = observedAt
    this.turns.end('zcode app-server exited')
    this.prompts.clear()
    this.lane?.dispose()
  }

  async close(): Promise<boolean> {
    this.closeRequested = true
    this.readingUnbind?.()
    this.readingUnbind = null
    return this.connection.close()
  }
}
