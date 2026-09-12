import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { getLatestPtyTitle } from './runtime-worktree-status-projection'

export function getIncumbentTerminalMetadata(
  pty: RuntimePtyWorktreeRecord,
  tabs: RuntimeMobileSessionTabsSnapshot['tabs'] | undefined,
  tabId: string,
  leafId: string
) {
  const surface = tabs?.find(
    (tab) =>
      pty.incarnationId !== null &&
      tab.type === 'terminal' &&
      tab.parentTabId === tabId &&
      tab.leafId === leafId &&
      tab.ptyId === pty.ptyId &&
      (tab.incarnationId ?? null) === pty.incarnationId
  )
  const terminal = surface?.type === 'terminal' ? surface : undefined
  const launch = pty.launchSurface
  return {
    title: getLatestPtyTitle(pty) ?? terminal?.title ?? null,
    // An explicit root launch must not inherit a prior surface's subdirectory.
    cwd: launch ? launch.startupCwd : terminal?.startupCwd,
    viewMode: terminal?.viewMode ?? launch?.viewMode,
    launchConfig: pty.launchConfig ?? undefined,
    launchToken: pty.launchToken ?? undefined,
    launchAgent: pty.launchAgent ?? undefined
  }
}

export function recordTerminalLaunchSurface(
  pty: RuntimePtyWorktreeRecord,
  cwd: string,
  workspacePath: string,
  viewMode?: 'terminal' | 'chat'
): void {
  pty.launchSurface = {
    ...(cwd !== workspacePath ? { startupCwd: cwd } : {}),
    ...(viewMode ? { viewMode } : {})
  }
}
