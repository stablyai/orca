import type { Worktree } from './workspace-list-types'

// Why: the previous 10-minute lastOutputAt window was too strict — most
// worktrees with idle terminal prompts had no recent output and were excluded.
// Any worktree with live terminals or unread output counts as "active".
export function isWorktreeActive(w: Worktree): boolean {
  if (w.hasHostSidebarActivity !== undefined) {
    return w.hasHostSidebarActivity
  }
  if (w.unread) {
    return true
  }
  if (w.status) {
    return w.status !== 'inactive'
  }
  if (w.liveTerminalCount > 0) {
    return true
  }
  return false
}

export function getWorktreeStatus(
  w: Worktree
): 'working' | 'active' | 'permission' | 'done' | 'inactive' {
  // Why: desktop's sidebar activity is the parity source. Runtime status may
  // still report retained/background PTYs as active after desktop hides them.
  if (w.hasHostSidebarActivity === false) {
    return 'inactive'
  }
  if (w.status && w.status !== 'inactive') {
    return w.status
  }
  if (w.hasHostSidebarActivity === true) {
    return 'active'
  }
  if (w.status) {
    return w.status
  }
  if (w.liveTerminalCount > 0) {
    return 'active'
  }
  return 'inactive'
}
