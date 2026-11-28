/** A running ZCode chat: the durable `zcode app-server` anchor Orca's lease holds, the shared timeline
 *  lane its turns journal through, and the chat session manager that runs one process per prompt. */

import { randomUUID } from 'node:crypto'
import { isAgentSessionProviderHandleField } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  AgentSessionProviderHandle,
  AgentSessionProviderHandleLink
} from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import type {
  AgentSessionDispatchOutcome,
  StructuredAgentSessionAcquireInput
} from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { StructuredAgentSessionProviderOpenResult } from '../../native-chat/agent-session-wire/startup/structured-agent-session-provider-open-contract'
import { AgentSessionPreSpawnError } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import { providerTimelineSink } from '../../native-chat/agent-session-timeline/provider-timeline-plan'
import { JsonlRpcTimelineLane } from '../../jsonl-rpc/timeline-lane'
import {
  spawnManagedProviderProcess,
  type ManagedProviderProcess
} from '../../provider-process/managed-provider-process'
import type { ProviderProcessCloseResult } from '../../provider-process/provider-process-close'
import { ZCODE_STRUCTURED_HANDLE_NAMESPACE } from './zcode-provider-handle'
import { ZcodeChatSession } from './zcode-chat-session'
import type { ZcodeResolvedLaunch } from './zcode-launch'
import type { StructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'

export type ZcodeComposedLaunch = ZcodeResolvedLaunch & {
  cwd: string
  env: Record<string, string>
  envToDelete: readonly string[]
}

export type ZcodeAdapterDeps = {
  resolveLaunch: (input: {
    identity: AgentSessionJournalIdentity
    spawnToken: string
  }) => Promise<ZcodeComposedLaunch>
  persistResumePoint: (input: {
    sessionId: string
    fence: number
    handle: AgentSessionProviderHandle
  }) => Promise<void>
  onSettled: (input: {
    sessionId: string
    clientMessageId: string
    outcome: AgentSessionDispatchOutcome
  }) => void
  readProcessStartTime?: (pid: number) => Promise<number | null>
  logger: StructuredAgentSessionLogger
}

/** The durable per-chat provider process; it anchors the lease and is killed on close. */
export class ZcodeAnchor {
  private readonly managed: ManagedProviderProcess
  constructor(launch: ZcodeComposedLaunch) {
    this.managed = spawnManagedProviderProcess(
      {
        command: launch.command,
        args: ['app-server'],
        cwd: launch.cwd,
        env: launch.env,
        envToDelete: launch.envToDelete
      },
      { site: 'zcode-anchor-teardown' }
    )
    // The app-server's notifications are not our protocol; drain so it never blocks on a full pipe.
    this.managed.child.stdout.resume()
  }
  get pid(): number | undefined {
    return this.managed.child.pid
  }
  get live(): boolean {
    return this.managed.rootVerdict !== 'exited'
  }
  close(): Promise<ProviderProcessCloseResult> {
    return this.managed.close()
  }
  onExit(listener: () => void): void {
    this.managed.onExit(() => listener())
  }
}

export class ZcodeHostedSession {
  readonly generation: string
  readonly chat: ZcodeChatSession
  readonly lane: JsonlRpcTimelineLane
  private resumeLink: AgentSessionProviderHandleLink | null
  private readonly options: Map<string, string>
  private failed: Error | null = null

  constructor(
    private readonly input: StructuredAgentSessionAcquireInput,
    readonly anchor: ZcodeAnchor,
    private readonly deps: ZcodeAdapterDeps,
    launch: ZcodeComposedLaunch
  ) {
    this.generation = randomUUID()
    this.resumeLink = launch.previous
    this.options = new Map(Object.entries(input.options ?? {}))
    const sink = input.events ? providerTimelineSink(input.events) : null
    if (!sink) {
      throw new AgentSessionPreSpawnError(new Error('ZCode chat needs a journal event sink'))
    }
    this.lane = new JsonlRpcTimelineLane({
      sink,
      sessionId: input.identity.sessionId,
      agent: 'zcode',
      generation: this.generation,
      namespace: ZCODE_STRUCTURED_HANDLE_NAMESPACE.transport,
      pauseReading: () => {},
      resumeReading: () => {},
      onInputAccepted: () => {},
      onFailed: (reason) => this.fail(new Error(reason))
    })
    this.chat = new ZcodeChatSession(
      {
        command: launch.command,
        prefixArgs: launch.prefixArgs,
        cwd: launch.cwd,
        env: launch.env,
        envToDelete: launch.envToDelete
      },
      {
        onEvents: (events) => this.lane.apply(events),
        onTurnSettled: ({ clientMessageId, outcome }) =>
          this.deps.onSettled({ sessionId: input.identity.sessionId, clientMessageId, outcome }),
        onProviderSessionId: (nativeId) => void this.recordResumePoint(nativeId),
        onError: () => {}
      },
      launch.previous?.handle.nativeId ?? null
    )
  }

  get live(): boolean {
    return !this.failed && this.anchor.live
  }

  open(signal: AbortSignal): StructuredAgentSessionProviderOpenResult {
    if (signal.aborted || !this.live) {
      throw (
        this.failed ?? new AgentSessionPreSpawnError(new Error('ZCode chat ended before it opened'))
      )
    }
    return { reportedOptions: {}, ...(this.resumeLink ? { link: this.resumeLink } : {}) }
  }

  dispatch(prompt: string, clientMessageId: string, requestedAt: number) {
    return this.chat.submit({
      clientMessageId,
      prompt,
      requestedAt,
      ...(this.options.get('model') ? { model: this.options.get('model') } : {}),
      ...(this.options.get('effort') ? { effort: this.options.get('effort') } : {})
    })
  }

  applyOption(key: string, value: string): Readonly<Record<string, string>> {
    this.options.set(key, value)
    return this.optionsSnapshot()
  }

  optionsSnapshot(): Readonly<Record<string, string>> {
    return Object.fromEntries(this.options)
  }

  cancel(): void {
    this.chat.cancel()
  }

  async close(): Promise<void> {
    this.chat.close()
    await this.anchor.close()
    this.lane.dispose()
  }

  fail(error: Error): void {
    if (this.failed) {
      return
    }
    this.failed = error
    this.input.events?.observeExit?.(new Set(), Date.now())
    this.lane.finalize({
      type: 'session.ended',
      verdict: { state: 'interrupted', completedAt: Date.now() }
    })
  }

  private async recordResumePoint(nativeId: string): Promise<void> {
    if (!isAgentSessionProviderHandleField(nativeId)) {
      return
    }
    const handle: AgentSessionProviderHandleLink = {
      linkId: `zcode-${nativeId}`,
      handle: { ...ZCODE_STRUCTURED_HANDLE_NAMESPACE, nativeId },
      origin: this.resumeLink ? 'resumed' : 'created',
      mintedAtFence: this.input.fence,
      observedAt: Date.now()
    }
    this.resumeLink = handle
    try {
      await this.deps.persistResumePoint({
        sessionId: this.input.identity.sessionId,
        fence: this.input.fence,
        handle: handle.handle
      })
    } catch (error) {
      this.deps.logger.warn('ZCode resume point could not be persisted', {
        scope: 'zcode-resume-point',
        sessionId: this.input.identity.sessionId,
        error
      })
    }
  }
}
