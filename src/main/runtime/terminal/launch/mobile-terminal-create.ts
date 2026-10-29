import type { MobileTerminalCreateOptions } from './mobile-terminal-renderer-create'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-session-contracts'
import { OrcaRuntimeWithFailedStartPanes } from './failed-start-pane'
import type { WorktreeStartupLaunch } from '../../../../shared/worktree/launch-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../../shared/agent-session-resume'
import type { RuntimeNavigationTarget } from '../../../../shared/runtime-navigation'
import type {
  RuntimeTerminalCreate,
  RuntimeMobileSessionCreateTerminalResult,
  RuntimeTerminalPresentation
} from '../../../../shared/runtime-types'
import type { SpawnIntent } from '../../../../shared/host-spawn-admission'
import type { AgentLaunchRuntime } from '../../../../shared/agent-launch-runtime'
import { navigationTargetsHost } from '../../../../shared/runtime-navigation'
import { MOBILE_TERMINAL_CREATE_RESULT_TTL_MS } from '../../orca-runtime-core'
import { seedResumeLaunchIdentity } from '../../../ipc/pty/pane/resume-launch-identity'

export type OwnedMobileTerminalCreateOptions = {
  command?: string
  shellOverride?: string
  cwd?: string
  env?: Record<string, string>
  envToDelete?: string[]
  startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
  identity?: { tabId: string; leafId: string; sessionId?: string }
  createMutation?: { clientIdentity: string; id: string }
  launchAgent?: TuiAgent
  viewMode?: 'terminal' | 'chat'
  targetGroupId?: string
  afterDesktopTabId?: string
  presentation?: RuntimeTerminalPresentation
  supportsSplitGroupPlacement?: boolean
  launchConfig?: SleepingAgentLaunchConfig
  resumeProviderSession?: AgentProviderSessionMetadata
  resumeOrigin?: 'saved'
  spawnIntent?: SpawnIntent
  launchRuntime?: AgentLaunchRuntime
  signal?: AbortSignal
  refuseSleptWorktree?: boolean
  resumesSleepingRecord?: true
  /** See TerminalCreateOptions; a create that throws before it proves nothing spawned. */
  onPtySpawnDispatched?: () => void
  /** The PTY this create produced, reported before publication can fail. */
  onPtyCreated?: (ptyId: string, result: RuntimeTerminalCreate) => void
}

export abstract class OrcaRuntimeWithCreateMobileSessionTerminal extends OrcaRuntimeWithFailedStartPanes {
  protected abstract runCreateMobileSessionTerminal(
    worktreeSelector: string,
    opts?: MobileTerminalCreateOptions
  ): Promise<RuntimeMobileSessionCreateTerminalResult>

  protected abstract getValidatedExplicitWorktreeIdSelector(
    selector: string | undefined
  ): string | null

  abstract getExplicitSessionWorktreeIdSelector(selector: string | undefined): string | null

  protected abstract getMobileSessionTabsForWorktree(
    worktreeId: string,
    clientNavigationId?: string
  ): RuntimeMobileSessionTabsResult

  async createMobileSessionTerminal(
    worktreeSelector: string,
    opts: {
      afterTabId?: string
      sourceChatFork?: { sessionId: string }
      targetGroupId?: string
      command?: string
      shellOverride?: string
      cwd?: string
      env?: Record<string, string>
      envToDelete?: string[]
      startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
      agent?: TuiAgent
      agentPrompt?: string
      launchConfig?: SleepingAgentLaunchConfig
      resumeProviderSession?: AgentProviderSessionMetadata
      launchAgent?: TuiAgent
      terminalImageViewerSupported?: boolean
      viewMode?: 'terminal' | 'chat'
      activate?: boolean
      select?: boolean
      clientNavigationId?: string
      navigation?: RuntimeNavigationTarget
      clientMutationId?: string
      // Older mobile clients optimistically append; preserve that placement until they advertise
      // split-group ordering support.
      supportsSplitGroupPlacement?: boolean
      signal?: AbortSignal
    } = {}
  ): Promise<RuntimeMobileSessionCreateTerminalResult> {
    const navigation = opts.navigation ?? 'all'
    const select = opts.select ?? opts.activate !== false
    const runOpts = {
      ...opts,
      activate: select && navigationTargetsHost(navigation)
    }
    const mutationId = opts.clientMutationId
    const startRun = async (): Promise<RuntimeMobileSessionCreateTerminalResult> => {
      const created = await this.runCreateMobileSessionTerminal(worktreeSelector, runOpts)
      this.seedMobileResumeIdentity(created, opts)
      return created
    }
    let result: RuntimeMobileSessionCreateTerminalResult
    if (!mutationId) {
      result = await startRun()
    } else {
      // Idempotency belongs to the caller; paired devices may reuse mutation ids independently.
      const mutationKey = `${opts.clientNavigationId ?? 'local'}\0${worktreeSelector}\0${mutationId}`
      // Join in-flight creates and briefly retain successes for lost-response retries; drop failures so a genuine retry can start fresh.
      const inflight = this.mobileTerminalCreateByMutationId.get(mutationKey)
      const run = inflight ?? startRun()
      if (!inflight) {
        this.mobileTerminalCreateByMutationId.set(mutationKey, run)
        const drop = (): void => {
          if (this.mobileTerminalCreateByMutationId.get(mutationKey) === run) {
            this.mobileTerminalCreateByMutationId.delete(mutationKey)
          }
        }
        void run.then(() => {
          setTimeout(drop, MOBILE_TERMINAL_CREATE_RESULT_TTL_MS).unref?.()
        }, drop)
      }
      result = await run
    }
    if (select) {
      const worktreeId =
        this.getExplicitSessionWorktreeIdSelector(worktreeSelector) ??
        (await this.resolveWorkspaceSelector(worktreeSelector)).id
      this.applyMobileSessionTabNavigation(
        this.getMobileSessionTabsForWorktree(worktreeId),
        result.tab.id,
        navigation,
        opts.clientNavigationId
      )
    }
    return result
  }

  /** A client-typed resume (phone Session History) names its conversation before the agent does. */
  private seedMobileResumeIdentity(
    created: RuntimeMobileSessionCreateTerminalResult,
    opts: { resumeProviderSession?: AgentProviderSessionMetadata; launchAgent?: TuiAgent }
  ): void {
    if (!opts.resumeProviderSession || !created.tab.terminal) {
      return
    }
    const pty = this.getLivePtyForHandle(created.tab.terminal)?.pty
    const paneKey = this.paneOfPty(pty).paneKey
    // Why: an SSH pane's status rows belong to the relay on that host.
    if (!pty || !paneKey || pty.connectionId) {
      return
    }
    seedResumeLaunchIdentity({
      paneKey,
      launchAgent: opts.launchAgent,
      resumeProviderSession: opts.resumeProviderSession,
      worktreeId: pty.worktreeId,
      // This resume owns the new pane from time zero; reconciled live retries must retain the agent's own report.
      launchedAt: 0
    })
  }
}
