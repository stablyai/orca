import type { BrowserWindow, WebContents } from 'electron'
import { sendToTrustedUIRenderer } from '../../ipc/ui'
import type {
  WorkspacePopoutCloseReason,
  WorkspacePopoutEntrySummary,
  WorkspacePopoutState,
  WorkspacePopoutStateChanged,
  WorkspacePopoutTarget
} from '../../../shared/workspace-popout/workspace-popout-contract'

export type WorkspacePopoutEntry = {
  worktreeId: string
  target: WorkspacePopoutTarget
  window: BrowserWindow
  state: WorkspacePopoutState
  closeReason?: WorkspacePopoutCloseReason
  crashCount: number
  firstCrashTimestamp: number
}

export const popoutsByWorktreeId = new Map<string, WorkspacePopoutEntry>()
export const stateChangedListeners = new Set<(event: WorkspacePopoutStateChanged) => void>()

export function onWorkspacePopoutStateChanged(
  listener: (event: WorkspacePopoutStateChanged) => void
): () => void {
  stateChangedListeners.add(listener)
  return () => stateChangedListeners.delete(listener)
}

export function broadcastPopoutStateChanged(event: WorkspacePopoutStateChanged): void {
  sendToTrustedUIRenderer('workspacePopout:stateChanged', event)
  for (const listener of stateChangedListeners) {
    listener(event)
  }
}

export function isWorkspacePopoutRenderer(sender: WebContents): boolean {
  for (const entry of popoutsByWorktreeId.values()) {
    if (!entry.window.isDestroyed() && entry.window.webContents === sender) {
      return true
    }
  }
  return false
}

export function getWorkspacePopoutEntryForWebContents(
  sender: WebContents
): WorkspacePopoutEntry | null {
  for (const entry of popoutsByWorktreeId.values()) {
    if (!entry.window.isDestroyed() && entry.window.webContents === sender) {
      return entry
    }
  }
  return null
}

export function listWorkspacePopouts(): readonly WorkspacePopoutEntrySummary[] {
  const summaries: WorkspacePopoutEntrySummary[] = []
  for (const entry of popoutsByWorktreeId.values()) {
    if (!entry.window.isDestroyed()) {
      summaries.push({
        worktreeId: entry.worktreeId,
        tabId: entry.target.tabId,
        ptyId: entry.target.ptyId,
        state: entry.state
      })
    }
  }
  return summaries
}

export function getWorkspacePopoutTarget(
  targetOrWorktreeId: string | WebContents
): WorkspacePopoutTarget | null {
  if (typeof targetOrWorktreeId === 'string') {
    const entry = popoutsByWorktreeId.get(targetOrWorktreeId)
    return !entry || entry.window.isDestroyed() ? null : entry.target
  }
  const entry = getWorkspacePopoutEntryForWebContents(targetOrWorktreeId)
  return entry ? entry.target : null
}

export function setWorkspacePopoutTarget(
  worktreeId: string,
  target: WorkspacePopoutTarget
): boolean {
  const entry = popoutsByWorktreeId.get(worktreeId)
  if (!entry || entry.state === 'closing') {
    return false
  }
  const tabChanged = entry.target.tabId !== target.tabId || entry.target.ptyId !== target.ptyId
  if (tabChanged) {
    const oldTabId = entry.target.tabId
    entry.target = target
    broadcastPopoutStateChanged({ worktreeId, tabId: oldTabId, open: false, reason: 'replaced' })
    broadcastPopoutStateChanged({ worktreeId, tabId: target.tabId, open: true })
  } else {
    entry.target = target
  }
  if (!entry.window.isDestroyed()) {
    entry.window.webContents.send('workspacePopout:target', target)
    if (target.title) {
      entry.window.setTitle(target.title)
    }
  }
  return true
}
