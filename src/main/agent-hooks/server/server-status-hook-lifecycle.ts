import {
  drainAgentHookSpoolAsync,
  type SpoolRecord
} from '../../../shared/agent-hook-listener/transport/agent-hook-spool'
import { hookRootAnswerDeadline } from '../../../shared/agent-hook-listener/presence/hook-root-attempts'
import { AgentHookServerRuntimeEnv } from './server-runtime-env'
import { ClaudeAgentViewBridge } from '../../claude/agent-view/agent-view-bridge'
import { ClaudeTerminalMailBridge } from '../../claude/terminal-mail/claude-terminal-mail-bridge'
import {
  CLAUDE_AGENT_VIEW_PATH,
  CLAUDE_TERMINAL_MAIL_PATH
} from '../../../shared/claude-agent-view'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AgentHookSource } from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { respondAfterAgentToolPluginHooks } from '../tool-events/agent-tool-plugin-hooks'
import { ClaudePermissionHookHolds } from './claude-permission-hook-hold'

export abstract class AgentHookServerStatusHookLifecycle extends AgentHookServerRuntimeEnv {
  readonly claudeAgentViews = new ClaudeAgentViewBridge()
  readonly claudeTerminalMail = new ClaudeTerminalMailBridge()
  protected readonly claudePermissionHooks = new ClaudePermissionHookHolds()
  private statusHookInitialization: Promise<void> | null = null

  /** The reply to a request from Orca's Claude plugin, or null when `pathname` is not one of its. */
  protected receiveClaudePlugin(pathname: string, body: unknown): object | null {
    if (pathname === CLAUDE_AGENT_VIEW_PATH) {
      return this.claudeAgentViews.receive(body)
    }
    return pathname === CLAUDE_TERMINAL_MAIL_PATH ? this.claudeTerminalMail.receive(body) : null
  }

  protected clearClaudePlugins(): void {
    this.claudeAgentViews.clear()
    this.claudeTerminalMail.clear()
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

  setStatusHooksEnabled(enabled: boolean): void {
    if (enabled === this.statusHooksEnabled) {
      return
    }
    this.statusHookGeneration += 1
    if (!enabled) {
      this.clearClaudePlugins()
      this.flushStatusPersistSync()
      this.stopOpenCodeBinderLoop()
      for (const timer of this.assistantMessageRetryTimers.values()) {
        clearTimeout(timer)
      }
      this.assistantMessageRetryTimers.clear()
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
        for (const paneKey of replayedPaneKeys) {
          void this.checkAgentPresence(paneKey)
        }
      }
      this.ownerStateInitialized = true
      this.activateClaudeHelperObservations()
    }
  }
}
