import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import type { StructuredAgentSessionProviderOpenResult } from '../../../native-chat/agent-session-wire/startup/structured-agent-session-provider-open-contract'
import type { StructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import type { StructuredAgentSessionAcquireInput } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { ZcodeAppServerConnection } from '../../app-server/zcode-app-server-connection-types'
import { formatZcodeModelOption } from '../launch/zcode-structured-launch-resolution'
import type { ZcodeStructuredLane } from '../timeline/zcode-structured-lane'
import { ZcodeStructuredOptions } from '../options/zcode-structured-options'
import { ZcodeStructuredPrompts } from '../prompts/zcode-structured-prompts'
import { journalZcodeModelSwitchNotice } from './zcode-model-switch-notice'
import type { ZcodeChatCredentials } from '../credentials/zcode-chat-credentials'
import { ZcodeStructuredTurns, type ZcodeSendSettlement } from '../turns/zcode-structured-turns'
import { openZcodeSession } from './zcode-structured-session-open'
import type {
  ZcodeStructuredLaunch,
  ZcodeStructuredSessionEvent
} from './zcode-structured-session-state'

// One zcode app-server child serving one Orca chat. Frames arrive from the spawn handlers; the
// handshake (runtime preferences, account push, create/resume, subscribe) happens in `open`.

export type ZcodeStructuredSessionDeps = {
  acquire: StructuredAgentSessionAcquireInput
  generation: string
  launch: ZcodeStructuredLaunch
  logger?: StructuredAgentSessionLogger
  now: () => number
  requestTimeoutMs: number | null
  onEvent: (event: ZcodeStructuredSessionEvent) => void
  /** The provider session id a resume continues; null creates a new session. */
  resumeSessionId: string | null
  /** Orca's plan credentials for the account push and runtime-header asks. */
  resolveChatCredentials: () => ZcodeChatCredentials | null
  forceClose: (sessionId: string, reason: string) => void
  onSettled: (settlement: ZcodeSendSettlement) => void
}

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
  private lastNoticeTurnId: string | null = null
  private lastTurnModelId: string | null = null
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
      // The ask names the model this turn runs; a change from the last turn journals the switch.
      const ask = readRecord(params)
      const askProvider = readString(ask?.providerId)
      const askModel =
        readString(readRecord(ask?.modelSelection)?.modelId) ?? readString(ask?.modelId)
      const askTurnId = readString(ask?.turnId)
      if (askProvider && askModel && askTurnId && askTurnId !== this.lastNoticeTurnId) {
        // First ask of a turn: what this turn routes on. A turn whose model differs from the
        // previous turn's journals the switch; later asks of the same turn change nothing.
        const reported = formatZcodeModelOption({ providerId: askProvider, modelId: askModel })
        const providerSessionId = this.providerSessionId
        if (
          providerSessionId &&
          this.lastTurnModelId !== null &&
          reported !== this.lastTurnModelId
        ) {
          this.emitModelSwitchNotice(providerSessionId, this.lastTurnModelId, reported)
        }
        this.lastTurnModelId = reported
        this.lastNoticeTurnId = askTurnId
      }
      const credentials = this.deps.resolveChatCredentials()
      if (credentials) {
        this.connection.respond(id, {
          headersApplied: true,
          requestAuth: { apiKey: credentials.apiKey }
        })
      } else {
        this.connection.respondWithError(id, -32000, 'no coding plan key is available to Orca')
      }
      return
    }
    if (method === 'interaction/requestOfficialMcpAuthHeaders') {
      this.connection.respondWithError(id, -32000, 'official MCP auth is unavailable in Orca chats')
      return
    }
    if (method === 'interaction/requestPermission' || method === 'interaction/requestUserInput') {
      void this.prompts.handle(method, params, id).catch((error: unknown) => {
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

  /** One notice per real routing change, parsed from the outgoing headers ask — never from picks. */
  private emitModelSwitchNotice(providerSessionId: string, from: string, to: string): void {
    const lane = this.lane
    if (!lane) {
      return
    }
    journalZcodeModelSwitchNotice({
      lane,
      providerSessionId,
      options: this.options,
      from,
      to,
      at: this.deps.now()
    })
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

  markEnded(observedAt: number): void {
    this.ended = true
    this.exitObservedAt = observedAt
    this.turns.end('zcode app-server exited')
    this.prompts.clear()
    this.lane?.dispose()
  }

  async close(): Promise<boolean> {
    this.closeRequested = true
    return this.connection.close()
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
      (value as Record<string, unknown>)
    : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
