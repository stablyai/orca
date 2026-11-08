import {
  DASHBOARD_MAX_LABEL_LENGTH,
  type DashboardCardDotState
} from '../../shared/dashboard-snapshot'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import type {
  FloatingWorkspaceWindowActiveTab,
  FloatingWorkspaceWindowSnapshot
} from '../../shared/floating-workspace-window'
import { isRemoteRuntimePtyId } from '../../shared/remote-runtime/remote-runtime-pty-id'
import { isPtySessionIdOwnedByWorktree } from '../../shared/terminal/pty/lifecycle/pty-session-id-format'
import {
  DASHBOARD_DOT_STATES,
  isDashboardPaneKey,
  isDashboardTerminalInput
} from './dashboard-payload-validation'

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return Object.fromEntries(Object.entries(value))
}

function isDotState(value: unknown): value is DashboardCardDotState {
  return typeof value === 'string' && DASHBOARD_DOT_STATES.has(value)
}

// Why: a buggy publish must not let the window name a PTY that belongs to another workspace.
function admitPtyId(ptyId: unknown, kind: unknown): { ptyId: string | null } | null {
  if (ptyId === null) {
    return { ptyId: null }
  }
  return kind === 'terminal' &&
    isDashboardPaneKey(ptyId) &&
    (isRemoteRuntimePtyId(ptyId) ||
      isPtySessionIdOwnedByWorktree(ptyId, FLOATING_TERMINAL_WORKTREE_ID))
    ? { ptyId }
    : null
}

function admitActiveTab(value: unknown): FloatingWorkspaceWindowActiveTab | null {
  const tab = asRecord(value)
  if (!tab) {
    return null
  }
  const { tabId, title, kind, status, paneKey, terminalInput } = tab
  const pty = admitPtyId(tab.ptyId, kind)
  if (
    !isDashboardPaneKey(tabId) ||
    typeof title !== 'string' ||
    title.length > DASHBOARD_MAX_LABEL_LENGTH ||
    (kind !== 'terminal' && kind !== 'other') ||
    !isDotState(status) ||
    !isDashboardPaneKey(paneKey) ||
    !isDashboardTerminalInput(terminalInput) ||
    !pty
  ) {
    return null
  }
  return {
    tabId,
    title,
    kind,
    status,
    paneKey,
    ptyId: pty.ptyId,
    ...(terminalInput ? { terminalInput } : {})
  }
}

/** Returns a rebuilt snapshot, or null when any field fails; the caller keeps its previous one. */
export function admitFloatingWorkspaceSnapshot(
  value: unknown
): FloatingWorkspaceWindowSnapshot | null {
  const snapshot = asRecord(value)
  if (!snapshot || snapshot.version !== 1) {
    return null
  }
  if (snapshot.activeTab === null) {
    return { version: 1, activeTab: null }
  }
  const activeTab = admitActiveTab(snapshot.activeTab)
  return activeTab ? { version: 1, activeTab } : null
}
