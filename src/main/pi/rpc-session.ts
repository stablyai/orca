import type {
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionLifecycleEvent,
  AgentSessionDispatchOutcome
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { providerTimelineSink } from '../native-chat/agent-session-timeline/provider-timeline-plan'
import { JsonlRpcTimelineLane } from '../jsonl-rpc/timeline-lane'
import {
  JsonlRpcAgentConnection,
  type JsonlRpcAgentConnectionOptions
} from '../jsonl-rpc/agent-connection'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import { piExitFailure } from './rpc-exit-classification'
import { PiRpcTurns } from './rpc-turns'
import { PiRpcDialogCallbacks } from './rpc-dialog-callbacks'
import { PiRpcOptionObservations, type PiRpcOptionWrite } from './rpc-options'
import type { PiRpcResolvedLaunch } from './rpc-launch-resolution'
import type { StructuredAgentSessionProviderOpenResult } from '../native-chat/agent-session-wire/structured-agent-session-provider-open-contract'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import { PiRpcSessionStartup } from './rpc-session-startup'
import { PiHistoryCapture, type PiHistoryCaptureDeps } from './rpc-history-capture'

export type PiRpcConnection = Pick<
  JsonlRpcAgentConnection,
  | 'request'
  | 'send'
  | 'close'
  | 'pauseReading'
  | 'resumeReading'
  | 'pid'
  | 'closed'
  | 'rootVerdict'
  | 'processless'
  | 'spawnAbsence'
  | 'lastCloseResult'
  | 'onExit'
>
export type PiRpcSessionDeps = PiHistoryCaptureDeps & {
  openConnection?: (
    launch: ProviderProcessLaunch,
    handlers: JsonlRpcAgentConnectionOptions
  ) => PiRpcConnection
  onLifecycle: (event: StructuredAgentSessionLifecycleEvent) => void
  onSettled: (input: {
    sessionId: string
    clientMessageId: string
    fence: number
    outcome: AgentSessionDispatchOutcome
  }) => void
  logger: StructuredAgentSessionLogger
}

export class PiRpcSession {
  readonly connection: PiRpcConnection
  readonly lane: JsonlRpcTimelineLane
  readonly turns: PiRpcTurns
  readonly dialogs: PiRpcDialogCallbacks
  readonly selected = new Map<string, string>()
  /** Hold sends from handover through settlement. */
  readonly heldSends = new Set<string>()
  readonly optionProof = {
    current: new Map<string, string>(),
    writes: new Map<string, PiRpcOptionWrite>()
  }
  private optionObservations = new PiRpcOptionObservations(
    this.optionProof,
    () => !this.requestedClose && !this.failedCause && !this.connection.closed
  )
  readonly startup: PiRpcSessionStartup
  readonly history = PiHistoryCapture.forSession(this, () => this.deps)
  openedLink: AgentSessionProviderHandleLink | null = null
  requestedClose = false
  private publishedExit = false
  private failedCause?: Error
  private exitDelivery: Promise<void> = Promise.resolve()
  private releaseAfterExit?: () => void

  constructor(
    readonly input: StructuredAgentSessionAcquireInput,
    readonly generation: string,
    launch: ProviderProcessLaunch,
    private readonly deps: PiRpcSessionDeps,
    private readonly resolvedLaunch: PiRpcResolvedLaunch
  ) {
    const sink = input.events && providerTimelineSink(input.events)
    if (!sink) {
      throw new Error('Pi structured chat requires the shared timeline sink')
    }
    this.lane = new JsonlRpcTimelineLane({
      sink,
      sessionId: input.identity.sessionId,
      agent: 'pi',
      generation,
      namespace: input.identity.sessionId,
      pauseReading: () => this.connection?.pauseReading(),
      resumeReading: () => this.connection?.resumeReading(),
      onFailed: (reason) => this.fail(new Error(reason)),
      onInputAccepted: (clientMessageId) =>
        this.settle(clientMessageId, {
          state: 'accepted',
          providerIdentity: { provider: 'orca', clientMessageId }
        })
    })
    this.turns = new PiRpcTurns({
      lane: this.lane,
      generation,
      send: (frame) => this.connection.send(frame),
      request: (command, params, options) => this.connection.request(command, params, options),
      prepareStateObservation: () =>
        this.optionObservations.prepareState((current) =>
          this.startup.reportOptions(generation, current)
        ),
      settled: (id, outcome) => this.settle(id, outcome),
      idle: () => this.dialogs.cancelAll(),
      turnEnded: () => this.history.turnEnded(),
      failed: (error) => this.fail(error),
      diagnostic: (error) =>
        deps.logger.warn('Pi context usage could not be read', {
          scope: 'pi-context-usage',
          sessionId: input.identity.sessionId,
          error
        })
    })
    this.dialogs = new PiRpcDialogCallbacks(
      this.lane,
      (frame) => this.connection.send(frame),
      (error) => this.fail(error)
    )
    this.connection = (
      deps.openConnection ?? ((spec, handlers) => new JsonlRpcAgentConnection(spec, handlers))
    )(launch, {
      onRecord: (frame) =>
        frame.type === 'extension_ui_request'
          ? this.dialogs.receive(frame)
          : this.turns.receive(frame),
      onOversizedEvent: (type, prefix) => this.turns.skipped(type, prefix),
      onClose: (error) => this.fail(error),
      onDiagnostic: (message) =>
        deps.logger.warn(message, { scope: 'pi-rpc', sessionId: input.identity.sessionId }),
      onExit: (error) => {
        this.exitDelivery = this.exit(error)
          .catch((cause: unknown) =>
            deps.logger.error('Pi exit publication failed', {
              scope: 'pi-exit',
              sessionId: input.identity.sessionId,
              error: cause
            })
          )
          .finally(() => this.releaseAfterExit?.())
      }
    })
    this.optionObservations.adoptLaunchIntent(resolvedLaunch.launchIntent)
    this.startup = new PiRpcSessionStartup(
      input,
      this.connection,
      deps,
      !resolvedLaunch.sessionFile && !resolvedLaunch.forkFile,
      (state) => {
        this.lane.apply(this.turns.context.setModel(state.model ?? undefined, Date.now()))
        this.optionObservations.seed(state)
      },
      () => this.failedCause,
      () => this.optionObservations.prepare()
    )
  }

  async submit(...args: Parameters<PiRpcTurns['submit']>): ReturnType<PiRpcTurns['submit']> {
    const [clientMessageId] = args
    this.heldSends.add(clientMessageId)
    let outcome: AgentSessionDispatchOutcome | undefined
    try {
      return (outcome = await this.turns.submit(...args))
    } finally {
      if (outcome?.state !== 'admitted') {
        this.heldSends.delete(clientMessageId)
      }
    }
  }

  async open(signal: AbortSignal): Promise<StructuredAgentSessionProviderOpenResult> {
    const result = await this.startup.run(this.resolvedLaunch, signal)
    this.openedLink = result.link ?? null
    this.history.start(this.startup.historyAnchor)
    this.startup.reportAfterOpen(this.generation, result.reportedOptions)
    return result
  }

  /** A read projects this child's held observations and successful controls. */
  async readOptions() {
    return this.optionObservations.read()
  }

  async close(requested = true): ReturnType<PiRpcConnection['close']> {
    this.requestedClose ||= requested
    this.dialogs.cancelAll()
    const result = await this.connection.close()
    if (result.killDelivered && result.root !== 'exited') {
      await this.exit(new Error('Pi writer killed'))
    }
    return result
  }

  fail(error: Error): void {
    this.failedCause ??= error
    this.deps.logger.error('Pi RPC session failed', {
      scope: 'pi-rpc',
      sessionId: this.input.identity.sessionId,
      error
    })
    if (!this.openedLink) {
      return
    }
    void this.close(false)
      .then((result) => {
        if (result.root !== 'exited' && !result.killDelivered) {
          this.deps.logger.warn('Pi process exit is unverifiable', {
            scope: 'pi-stop',
            sessionId: this.input.identity.sessionId
          })
        }
      })
      .catch((cause: unknown) =>
        this.deps.logger.error('Pi process cleanup failed', {
          scope: 'pi-stop',
          sessionId: this.input.identity.sessionId,
          error: cause
        })
      )
  }

  drainObservedExit(): Promise<void> {
    return this.exitDelivery
  }

  retire(): Promise<void> {
    return new Promise((resolve) => {
      this.releaseAfterExit = () => {
        this.releaseAfterExit = undefined
        void this.lane.drained().then(() => {
          this.lane.dispose()
          resolve()
        })
      }
      if (this.publishedExit) {
        void this.exitDelivery.then(() => this.releaseAfterExit?.())
      }
    })
  }

  private async exit(error: Error): Promise<void> {
    if (this.publishedExit) {
      return
    }
    this.publishedExit = true
    const observedAt = Date.now()
    this.input.events?.observeExit?.(this.heldSends, observedAt)
    const cause = (this.failedCause ??= error)
    this.dialogs.cancelAll()
    this.turns.end()
    // The lane is sealed once finalized, so the end event travels with the final transfer.
    this.lane.finalize({
      type: 'session.ended',
      verdict: { state: 'interrupted', completedAt: observedAt }
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      this.lane.drained(),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          this.deps.logger.warn('Pi final timeline did not drain before exit publication', {
            scope: 'pi-exit-drain',
            sessionId: this.input.identity.sessionId
          })
          resolve()
        }, 2_000)
        timer.unref()
      })
    ]).finally(() => clearTimeout(timer))
    this.deps.onLifecycle({
      type: 'ended',
      ...(this.connection.lastCloseResult?.killDelivered && this.connection.rootVerdict !== 'exited'
        ? { deathEvidenceKind: 'kill-delivered' as const }
        : {}),
      sessionId: this.input.identity.sessionId,
      fence: this.input.fence,
      acquisitionGeneration: this.generation,
      observedAt,
      cause: this.requestedClose ? 'requested-close' : 'unexpected-exit',
      reason: cause.message,
      failure: piExitFailure(error, cause)
    })
  }

  private settle(clientMessageId: string, outcome: AgentSessionDispatchOutcome): void {
    this.heldSends.delete(clientMessageId)
    this.deps.onSettled({
      sessionId: this.input.identity.sessionId,
      clientMessageId,
      fence: this.input.fence,
      outcome
    })
  }
}
