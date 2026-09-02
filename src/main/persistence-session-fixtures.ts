import type { TerminalPaneLayoutNode } from '../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../shared/workspace-session-state-types'
import { makeTerminalTab } from './persistence-test-harness'

export const TEST_LEAF_1 = '11111111-1111-4111-8111-111111111111'
export const TEST_LEAF_2 = '22222222-2222-4222-8222-222222222222'
export const TEST_LEAF_LIVE = '33333333-3333-4333-8333-333333333333'
export const TEST_LEAF_EXPIRED = '44444444-4444-4444-8444-444444444444'

export function makeSessionWithTerminalBuffers(): WorkspaceSessionState {
  return {
    activeRepoId: 'local-repo',
    activeWorktreeId: 'local-repo::/local',
    activeTabId: 'local-tab',
    tabsByWorktree: {
      'local-repo::/local': [
        makeTerminalTab({
          id: 'local-tab',
          ptyId: 'local-pty',
          worktreeId: 'local-repo::/local'
        })
      ],
      'remote-repo::/remote': [
        makeTerminalTab({
          id: 'remote-tab',
          ptyId: 'remote-pty',
          worktreeId: 'remote-repo::/remote'
        })
      ]
    },
    terminalLayoutsByTabId: {
      'local-tab': {
        root: { type: 'leaf', leafId: TEST_LEAF_1 },
        activeLeafId: TEST_LEAF_1,
        expandedLeafId: null,
        buffersByLeafId: { [TEST_LEAF_1]: 'local-scrollback' },
        ptyIdsByLeafId: { [TEST_LEAF_1]: 'local-pty' }
      },
      'remote-tab': {
        root: { type: 'leaf', leafId: TEST_LEAF_2 },
        activeLeafId: TEST_LEAF_2,
        expandedLeafId: null,
        buffersByLeafId: { [TEST_LEAF_2]: 'remote-scrollback' },
        ptyIdsByLeafId: { [TEST_LEAF_2]: 'remote-pty' }
      }
    }
  }
}

export function makeSessionWithBrowserHistory(count: number): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    browserUrlHistory: Array.from({ length: count }, (_, index) => ({
      url: `https://example.com/${index}`,
      normalizedUrl: `https://example.com/${index}`,
      title: `Example ${index} ${'x'.repeat(200)}`,
      lastVisitedAt: 1_700_000_000_000 - index,
      visitCount: 1
    }))
  }
}

export function makeBalancedLegacyPaneLayout(start: number, end: number): TerminalPaneLayoutNode {
  if (end - start === 1) {
    return { type: 'leaf', leafId: `pane:${start + 1}` }
  }
  const midpoint = Math.floor((start + end) / 2)
  return {
    type: 'split',
    direction: 'horizontal',
    first: makeBalancedLegacyPaneLayout(start, midpoint),
    second: makeBalancedLegacyPaneLayout(midpoint, end)
  }
}
