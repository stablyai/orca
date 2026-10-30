import { getDefaultWorkspaceSession } from '../../../shared/constants'
import {
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession
} from '../orca-runtime-test-fixtures.spec'

export const LEFT_LEAF = '51515151-5151-4151-8151-515151515151'
export const RIGHT_LEAF = '52525252-5252-4252-8252-525252525252'
export const TRAILING_LEAF = '53535353-5353-4353-8353-535353535353'
export const SPLIT_LEFT = `split::${LEFT_LEAF}`
export const SPLIT_RIGHT = `split::${RIGHT_LEAF}`
export const TRAILING = `trailing::${TRAILING_LEAF}`

export function splitPlacementStore() {
  const tab = (id: string, sortOrder: number) => ({
    id,
    ptyId: null,
    worktreeId: TEST_WORKTREE_ID,
    title: id === 'split' ? 'Split' : 'Trailing',
    customTitle: null,
    color: null,
    sortOrder,
    createdAt: sortOrder + 1
  })
  const leaf = (leafId: string) => ({ type: 'leaf' as const, leafId })
  return makeRuntimeStoreWithWorkspaceSession({
    ...getDefaultWorkspaceSession(),
    activeWorktreeId: TEST_WORKTREE_ID,
    tabsByWorktree: { [TEST_WORKTREE_ID]: [tab('split', 0), tab('trailing', 1)] },
    terminalLayoutsByTabId: {
      split: {
        root: {
          type: 'split',
          direction: 'vertical',
          first: leaf(LEFT_LEAF),
          second: leaf(RIGHT_LEAF)
        },
        activeLeafId: LEFT_LEAF,
        expandedLeafId: null
      },
      trailing: { root: leaf(TRAILING_LEAF), activeLeafId: TRAILING_LEAF, expandedLeafId: null }
    }
  }).runtimeStore
}
