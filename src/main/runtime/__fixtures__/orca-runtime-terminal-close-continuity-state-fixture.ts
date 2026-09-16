import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

export const REPO_ID = 'repo-close-continuity'
export const WORKTREE_PATH = '/tmp/terminal-close-continuity'
export const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`
export const TAB_ID = 'tab-close-continuity'
export const LEAF_ID = '11111111-1111-4111-8111-111111111111'
export const SIBLING_LEAF_ID = '33333333-3333-4333-8333-333333333333'
export const CANARY_TAB_ID = 'tab-close-continuity-canary'
export const CANARY_LEAF_ID = '55555555-5555-4555-8555-555555555555'
export const PTY_ID = 'pty-close-continuity'
export const RUNTIME_OWNED_PTY_ID = 'serve-close-continuity'
export const SIBLING_PTY_ID = 'pty-close-continuity-sibling'
export const CANARY_PTY_ID = 'pty-close-continuity-canary'
export const STALE_TAB_ID = 'tab-close-continuity-stale'
export const OTHER_WORKTREE_ID = `${REPO_ID}::/tmp/terminal-close-continuity-other`
export const INCARNATION_ID = '22222222-2222-4222-8222-222222222222'
export const SIBLING_INCARNATION_ID = '44444444-4444-4444-8444-444444444444'
export const CANARY_INCARNATION_ID = '66666666-6666-4666-8666-666666666666'

const canarySessionTab = {
  id: CANARY_TAB_ID,
  ptyId: CANARY_PTY_ID,
  worktreeId: WORKTREE_ID,
  title: 'Canary shell',
  customTitle: null,
  color: null,
  sortOrder: 1,
  createdAt: 2
}

const canarySessionLayout = {
  root: { type: 'leaf' as const, leafId: CANARY_LEAF_ID },
  activeLeafId: CANARY_LEAF_ID,
  expandedLeafId: null,
  ptyIdsByLeafId: { [CANARY_LEAF_ID]: CANARY_PTY_ID }
}

export const canarySyncedTab = {
  tabId: CANARY_TAB_ID,
  worktreeId: WORKTREE_ID,
  title: 'Canary shell',
  activeLeafId: CANARY_LEAF_ID,
  layout: { type: 'leaf' as const, leafId: CANARY_LEAF_ID }
}

export const canarySyncedLeaf = {
  tabId: CANARY_TAB_ID,
  worktreeId: WORKTREE_ID,
  leafId: CANARY_LEAF_ID,
  paneRuntimeId: 9,
  ptyId: CANARY_PTY_ID
}

export const canaryMobileTab = {
  type: 'terminal' as const,
  id: `${CANARY_TAB_ID}::${CANARY_LEAF_ID}`,
  parentTabId: CANARY_TAB_ID,
  leafId: CANARY_LEAF_ID,
  ptyId: CANARY_PTY_ID,
  title: 'Canary shell',
  isActive: false
}

export const canaryProcess = {
  id: CANARY_PTY_ID,
  incarnationId: CANARY_INCARNATION_ID,
  cwd: WORKTREE_PATH,
  title: 'Canary shell'
}

export function makeSession(ptyId = PTY_ID, includeCanary = false): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: TAB_ID,
          ptyId,
          worktreeId: WORKTREE_ID,
          title: 'Fixture shell',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        },
        ...(includeCanary ? [canarySessionTab] : [])
      ]
    },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: ptyId }
      },
      ...(includeCanary ? { [CANARY_TAB_ID]: canarySessionLayout } : {})
    },
    terminalPtyIncarnationsByPaneKey: {
      [makePaneKey(TAB_ID, LEAF_ID)]: INCARNATION_ID,
      ...(includeCanary
        ? { [makePaneKey(CANARY_TAB_ID, CANARY_LEAF_ID)]: CANARY_INCARNATION_ID }
        : {})
    }
  }
}
