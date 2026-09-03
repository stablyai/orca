import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import type { TerminalPaneSplitSource } from '../../shared/feature-education-telemetry'
import type { TerminalRevealIdentity } from '../../shared/terminal-reveal-identity'
import type { TuiAgent } from '../../shared/tui-agent'
import type { ClientHostedBrowserRowsEvent } from '../../shared/client-hosted-browser-rows'
import type {
  WorktreeBaseStatusEvent,
  WorktreeRemoteBranchConflictEvent
} from '../../shared/worktree/base-ref-drift-types'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import type {
  RuntimeBrowserDriverState,
  RuntimeMarkdownReadTabResult,
  RuntimeMarkdownSaveTabResult,
  RuntimeMobileSessionTabMove,
  RuntimeTerminalDriverState,
  RuntimeTerminalPresentation
} from '../../shared/runtime-types'

type DriverState = RuntimeTerminalDriverState

export type RuntimeNotifier = {
  automationsChanged?(payload: {
    selector?: { kind: 'self' } | { kind: 'ssh'; targetId: string } | { kind: 'orphan' }
    reason?: 'definition' | 'run' | 'usage'
  }): void
  worktreesChanged(repoId: string, renamed?: { oldWorktreeId: string; newWorktreeId: string }): void
  worktreeBaseStatus?(event: WorktreeBaseStatusEvent): void
  worktreeRemoteBranchConflict?(event: WorktreeRemoteBranchConflictEvent): void
  reposChanged(): void
  activateWorktree(
    repoId: string,
    worktreeId: string,
    setup?: CreateWorktreeResult['setup'],
    startup?: WorktreeStartupLaunch,
    defaultTabs?: CreateWorktreeResult['defaultTabs']
  ): void
  createTerminal(
    worktreeId: string,
    opts: {
      command?: string
      cwd?: string
      env?: Record<string, string>
      title?: string
      presentation?: RuntimeTerminalPresentation
    }
  ): void
  revealTerminalSession?(
    worktreeId: string,
    opts: {
      ptyId: string
      title?: string | null
      cwd?: string
      launchConfig?: SleepingAgentLaunchConfig
      launchToken?: string
      launchAgent?: TuiAgent
      viewMode?: 'terminal' | 'chat'
      activate?: boolean
      presentation?: RuntimeTerminalPresentation
      surfaceOwner?: false
      tabId?: string
      leafId?: string
      splitFromLeafId?: string
      splitDirection?: 'horizontal' | 'vertical'
      splitTelemetrySource?: TerminalPaneSplitSource
      focus?: boolean
      expectedProcessIdentity?: {
        terminalHandle: string
        incarnationId: string
      }
    }
  ):
    | Promise<{ tabId: string; title?: string | null; identity?: TerminalRevealIdentity }>
    | { tabId: string; title?: string | null; identity?: TerminalRevealIdentity }
    | void
  resolveLegacyWorkerTerminalRecovery?(
    paneKey: string,
    resolution: 'adopted' | 'exited' | 'rolled_back',
    ptyId?: string
  ): void
  splitTerminal(
    tabId: string,
    paneRuntimeId: number,
    opts: {
      direction: 'horizontal' | 'vertical'
      command?: string
      worktreeId?: string
      sourceLeafId?: string
      telemetrySource?: TerminalPaneSplitSource
      newLeafId?: string
    }
  ): void
  renameTerminal(tabId: string, title: string | null): void
  focusTerminal(tabId: string, worktreeId: string, leafId?: string | null): void
  focusEditorTab?(tabId: string, worktreeId: string): void
  closeSessionTab?(tabId: string, worktreeId: string): void | Promise<void>
  moveSessionTab?(worktreeId: string, move: RuntimeMobileSessionTabMove): void
  openFile?(
    worktreeId: string,
    filePath: string,
    relativePath: string,
    runtimeEnvironmentId?: string | null
  ): void
  openDiff?(
    worktreeId: string,
    filePath: string,
    relativePath: string,
    staged: boolean,
    runtimeEnvironmentId?: string | null
  ): void
  readMobileMarkdownTab?(worktreeId: string, tabId: string): Promise<RuntimeMarkdownReadTabResult>
  saveMobileMarkdownTab?(
    worktreeId: string,
    tabId: string,
    baseVersion: string,
    content: string
  ): Promise<RuntimeMarkdownSaveTabResult>
  closeTerminal(tabId: string, paneRuntimeId?: number): void
  closeTerminalTab?(
    tabId: string,
    options?: { localPtyTeardownOwnedExternally?: boolean; force?: boolean }
  ): Promise<void>
  sleepWorktree(worktreeId: string): void
  // Why: a phone opening a worktree wakes its slept agents by asking the host
  // renderer to run its own navigation-free wake (experimental agent sleep);
  // the runtime has no in-memory sleeping records or wake authority. Optional to
  // match the many renderer-backed notifier methods only the real bridge wires.
  resumeSleepingAgents?(worktreeId: string): void
  terminalFitOverrideChanged(
    ptyId: string,
    mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit',
    cols: number,
    rows: number
  ): void
  // Why: presence-based lock signal — desktop renderer mounts the lock
  // banner when `driver.kind === 'mobile'` and unmounts otherwise. The
  // structured payload (vs a `locked: boolean`) carries the active mobile
  // actor's clientId so the renderer can disambiguate multi-phone scenarios
  // and so a future write coordinator can use the same signal as scheduling
  // input. See docs/mobile-presence-lock.md.
  terminalDriverChanged(ptyId: string, driver: DriverState): void
  nativeChatLaunchDraftResolved?(
    tabId: string,
    resolution: { text: string; createdAt: number }
  ): void
  browserDriverChanged?(browserPageId: string, driver: RuntimeBrowserDriverState): void
  browserRemoteViewersChanged?(browserPageId: string, hasRemoteViewers: boolean): void
  clientHostedBrowserRowsChanged?(event: ClientHostedBrowserRowsEvent): void
}
