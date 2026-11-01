import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

/**
 * A tab's Windows launch choices, dropped on purpose: `shellOverride` names a Windows shell
 * (`wsl.exe`, PowerShell, Git Bash) the Linux host can't run, and `forceHostRuntime` pins a tab to
 * this desktop. The host starts its own shell. Unlisted, the session parser dropped them silently.
 */
export function withoutWindowsShellChoices(session: WorkspaceSessionState): WorkspaceSessionState {
  return {
    ...session,
    tabsByWorktree: Object.fromEntries(
      Object.entries(session.tabsByWorktree).map(([owner, tabs]) => [
        owner,
        tabs.map(({ shellOverride: _shell, forceHostRuntime: _pinned, ...tab }) => tab)
      ])
    )
  }
}
