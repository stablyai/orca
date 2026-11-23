import {
  drainAgentHookSpoolAsync,
  type SpoolRecord
} from '../../../shared/agent-hook-listener/transport/agent-hook-spool'
import { hookRootAnswerDeadline } from '../../../shared/agent-hook-listener/presence/hook-root-attempts'
import { AgentHookServerRuntimeEnv } from './server-runtime-env'
import { ClaudeAgentViewBridge } from '../../claude/agent-view/agent-view-bridge'
import { ClaudeTerminalMailBridge } from '../../claude/terminal-mail/claude-terminal-mail-bridge'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AgentHookSource } from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { EnrichedAgentHookEventPayload } from './server-types'
import { respondAfterAgentToolPluginHooks } from '../tool-events/agent-tool-plugin-hooks'
import { ClaudePermissionHookHolds } from './claude-permission-hook-hold'

export abstract class AgentHookServerStatusHookLifecycle extends AgentHookServerRuntimeEnv {
  readonly claudeAgentViews = this.createClaudeAgentViews()
  readonly claudeTerminalMail = new ClaudeTerminalMailBridge()
  protected readonly claudePermissionHooks = new ClaudePermissionHookHolds()
  private statusHookInitialization: Promise<void> | null = null
  private restoredOwnersChecked: Promise<void> = Promise.resolve()

  /** Settles once replayed hooks are in and each replayed pane's agent was probed once. */
  whenRestoredOwnersChecked(): Promise<void> {
    return (this.statusHookInitialization ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.restoredOwnersChecked)
  }

  /** Answers a hook post: a worker's PermissionRequest waits for its coordinator's or person's answer;
   *  plugins see only calls status accepted, so a fenced or reused pane's old agent is skipped. */
  protected async respondToHook(
    req: IncomingMessage,
    res: ServerResponse,
    source: AgentHookSource,
    body: unknown,
    accepted: AgentHookEventPayload | null
  ): Promise<void> {
    if (accepted && source === 'claude' && this.claudePermissionHooks.hold(req, res, accepted)) {
      return
    }
    await respondAfterAgentToolPluginHooks(res, source, body, req.headers, accepted)
  }

  /** Restored entries count only for panes whose hydrated status still shows a live Claude. The
   *  session may lag the registry after a crash; a click still needs the session to match. */
  protected restoreClaudeAgentViews(filePath: string): Promise<void> {
    // Without hydrated status (hooks off, or the store failed to load) a missing row proves nothing.
    const unchecked =
      !this.statusHooksEnabled ||
      this.statusHydrationFailed ||
      this.state.lastStatusByPaneKey.size === 0
    return this.claudeAgentViews.restore(
      filePath,
      (view) =>
        unchecked ||
        (!this.claudeAgentEnded(view.paneKey) &&
          // The mod keeps its launch pane key; a moved pane's row lives under the alias target.
          this.getStatusSnapshotForPane(this.resolvePaneKeyAlias(view.paneKey)).some(
            (row) => row.agentType === 'claude'
          ))
    )
  }

  private createClaudeAgentViews(): ClaudeAgentViewBridge {
    const bridge = new ClaudeAgentViewBridge()
    bridge.isLive = (paneKey, sessionId) =>
      !this.statusHooksEnabled ||
      (!this.claudeAgentEnded(paneKey) &&
        this.getStatusSnapshotForPane(this.resolvePaneKeyAlias(paneKey)).some(
          (row) =>
            row.agentType === 'claude' &&
            (!row.providerSession?.id || row.providerSession.id === sessionId)
        ))
    return bridge
  }

  /** A mod may stop checking in only where a click can probe its Claude process (a local pane with a
   *  recorded process; Windows hooks record none). Elsewhere it keeps the 5 s check-in and 15 s rule. */
  protected claudeViewMayGoQuiet(body: unknown): boolean {
    const paneKey =
      body && typeof body === 'object' && 'paneKey' in body && typeof body.paneKey === 'string'
        ? body.paneKey
        : undefined
    const row = paneKey && this.state.lastStatusByPaneKey.get(this.resolvePaneKeyAlias(paneKey))
    return Boolean(row && row.connectionId === null && row.agentPresence?.process)
  }

  /** Whether the pane's agent can take typed input now: its process runs and isn't stopped by job
   *  control (Ctrl-Z, then another program in front). A silent idle mod proves neither. */
  async agentAcceptsInput(paneKey: string): Promise<boolean> {
    if ((await this.checkAgentPresence(paneKey)) === 'exited') {
      return false
    }
    const row = this.state.lastStatusByPaneKey.get(this.resolvePaneKeyAlias(paneKey))
    return row?.agentPresence?.suspended !== true && row?.agentPresence?.ended !== true
  }

  private claudeAgentEnded(paneKey: string): boolean {
    return (
      this.state.lastStatusByPaneKey.get(this.resolvePaneKeyAlias(paneKey))?.agentPresence
        ?.ended === true
    )
  }

  // A pane's agent-view entry goes with its status row, the row's recorded exit, or another agent taking it.
  protected override commitStatusRowMutation(
    before: EnrichedAgentHookEventPayload | null | undefined,
    after: EnrichedAgentHookEventPayload | null | undefined,
    emit = true
  ): boolean {
    const committed = super.commitStatusRowMutation(before, after, emit)
    // A row moving to another pane is not its Claude ending; the mod keeps its original pane key.
    const replaced =
      before?.payload.agentType === 'claude' && after && after.payload.agentType !== 'claude'
    if (before && (!after || after.agentPresence?.ended || replaced)) {
      const sessionId = before.providerSession?.id
      const forgotten = this.claudeAgentViews.forget(before.paneKey, sessionId)
      // A moved pane's entry stays under the mod's launch key: find it by session, sparing any
      // other pane still running that session (two panes can resume one conversation).
      if (!forgotten && sessionId && before.payload.agentType === 'claude') {
        this.claudeAgentViews.forgetSession(
          sessionId,
          (paneKey) =>
            !this.claudeAgentEnded(paneKey) &&
            this.getStatusSnapshotForPane(this.resolvePaneKeyAlias(paneKey)).some(
              (row) => row.agentType === 'claude' && row.providerSession?.id === sessionId
            )
        )
      }
    }
    return committed
  }

  setStatusHooksEnabled(enabled: boolean): void {
    if (enabled === this.statusHooksEnabled) {
      return
    }
    this.statusHookGeneration += 1
    if (!enabled) {
      this.claudeAgentViews.release()
      this.claudeTerminalMail.clear()
      this.flushStatusPersistSync()
      this.stopOpenCodeBinderLoop()
      this.clearAllAssistantMessageRetries()
      this.clearAllTranscriptPolls()
    }
    this.statusHooksEnabled = enabled
    if (enabled && this.server) {
      void this.initializeStatusHookOwner().catch((error: unknown) => {
        console.error('[agent-hooks] status initialization failed', error)
      })
      this.startOpenCodeBinderLoop()
    }
  }

  protected initializeStatusHookOwner(): Promise<void> {
    this.statusHookInitialization ??= this.loadStatusHookOwner().finally(() => {
      this.statusHookInitialization = null
    })
    return this.statusHookInitialization
  }

  private async loadStatusHookOwner(): Promise<void> {
    const token = this.token
    const statusHookGeneration = this.statusHookGeneration
    if (!this.ownerStateInitialized) {
      // Hydrate before binding so the first live hook sees restored ownership.
      if (this.lastStatusFilePath) {
        this.hydrateLastStatusFromDisk()
      }
      this.captureHydratedAuthorityCommitments()
      // Drain before binding so replay cannot race live hooks.
      if (this.endpointDir) {
        const replayedPaneKeys = new Set<string>()
        // Why: records replay in order, so a per-record allowance would add up across panes.
        const answerBy = hookRootAnswerDeadline()
        await drainAgentHookSpoolAsync({
          endpointDir: this.endpointDir,
          getPersistedLaunchTokenHash: (paneKey) =>
            this.hydratedLaunchTokenHashByPaneKey.get(this.resolvePaneKeyAlias(paneKey)),
          ingest: async (record: SpoolRecord) => {
            if (this.token !== token || this.statusHookGeneration !== statusHookGeneration) {
              throw new Error('Status hook spool replay interrupted')
            }
            await this.ingestSpoolRecord(record, answerBy)
            replayedPaneKeys.add(this.resolvePaneKeyAlias(record.paneKey))
          }
        })
        if (this.token !== token || this.statusHookGeneration !== statusHookGeneration) {
          return
        }
        // Replayed owners may have died while Orca was down; probe each pane once.
        this.restoredOwnersChecked = Promise.allSettled(
          [...replayedPaneKeys].map((paneKey) => this.checkAgentPresence(paneKey))
        ).then(() => undefined)
      }
      this.ownerStateInitialized = true
      this.activateClaudeHelperObservations()
    }
  }
}
