import {
  closeTestStores,
  createStore,
  makeTerminalTab,
  testState
} from './persistence-test-harness'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalPaneLayoutNode } from '../shared/terminal-tab-types'
import type { TerminalPanePlacement } from '../shared/terminal-pane-placement'
import { TEST_LEAF_1, TEST_LEAF_2 } from './persistence-session-fixtures'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const WORKTREE = 'repo1::/worktree'
const TAB = 'tab1'
const NEW_LEAF = '55555555-5555-4555-8555-555555555555'
const UNKNOWN_LEAF = '66666666-6666-4666-8666-666666666666'

const leaf = (leafId: string): TerminalPaneLayoutNode => ({ type: 'leaf', leafId })
const SIDE_BY_SIDE: Extract<TerminalPaneLayoutNode, { type: 'split' }> = {
  type: 'split',
  direction: 'vertical',
  first: leaf(TEST_LEAF_1),
  second: leaf(TEST_LEAF_2)
}

type TestStore = ReturnType<typeof createStore>

/** Two panes side by side that the window saved; main has seen neither split command. */
function seedTwoPaneTab(store: TestStore, ratio?: number): void {
  store.setWorkspaceSession({
    activeRepoId: 'repo1',
    activeWorktreeId: WORKTREE,
    activeTabId: TAB,
    tabsByWorktree: { [WORKTREE]: [makeTerminalTab({ id: TAB, worktreeId: WORKTREE })] },
    terminalLayoutsByTabId: {
      [TAB]: {
        root: ratio === undefined ? SIDE_BY_SIDE : { ...SIDE_BY_SIDE, ratio },
        activeLeafId: TEST_LEAF_2,
        expandedLeafId: null,
        ptyIdsByLeafId: { [TEST_LEAF_1]: 'pty-1', [TEST_LEAF_2]: 'pty-2' }
      }
    }
  })
}

async function bindNewPane(store: TestStore, placement?: TerminalPanePlacement): Promise<void> {
  expect(
    await store.persistPtyBinding({
      worktreeId: WORKTREE,
      tabId: TAB,
      leafId: NEW_LEAF,
      ptyId: 'pty-new',
      origin: 'spawn',
      ...(placement ? { placement } : {})
    })
  ).toBe(true)
}

function root(store: TestStore): TerminalPaneLayoutNode | null | undefined {
  return store.getWorkspaceSession().terminalLayoutsByTabId[TAB]?.root
}

/** Today's guess for a pane main cannot place: the whole tree on the left, the pane on the right. */
const WRAPPED_AT_ROOT: TerminalPaneLayoutNode = {
  type: 'split',
  direction: 'vertical',
  first: SIDE_BY_SIDE,
  second: leaf(NEW_LEAF)
}

describe('a pane main first hears of at its terminal binding goes where the window split it', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-binding-graft-placement-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('splits the named pane top and bottom, leaving the other pane where it was', async () => {
    const store = createStore()
    seedTwoPaneTab(store)

    await bindNewPane(store, { kind: 'split', parentLeafId: TEST_LEAF_2, direction: 'horizontal' })

    expect(root(store)).toEqual({
      type: 'split',
      direction: 'vertical',
      first: leaf(TEST_LEAF_1),
      second: {
        type: 'split',
        direction: 'horizontal',
        first: leaf(TEST_LEAF_2),
        second: leaf(NEW_LEAF)
      }
    })
    const layout = store.getWorkspaceSession().terminalLayoutsByTabId[TAB]
    expect(layout?.activeLeafId).toBe(NEW_LEAF)
    expect(layout?.ptyIdsByLeafId?.[NEW_LEAF]).toBe('pty-new')
  })

  it('keeps the divider position the window chose', async () => {
    const store = createStore()
    seedTwoPaneTab(store)

    await bindNewPane(store, {
      kind: 'split',
      parentLeafId: TEST_LEAF_1,
      direction: 'horizontal',
      ratio: 0.3
    })

    expect(root(store)).toEqual({
      type: 'split',
      direction: 'vertical',
      first: {
        type: 'split',
        direction: 'horizontal',
        first: leaf(TEST_LEAF_1),
        second: leaf(NEW_LEAF),
        ratio: 0.3
      },
      second: leaf(TEST_LEAF_2)
    })
  })

  it("takes the window's tree when it is today's tree plus the new pane (a pane placed before)", async () => {
    const store = createStore()
    seedTwoPaneTab(store)
    const proposedRoot: TerminalPaneLayoutNode = {
      type: 'split',
      direction: 'vertical',
      first: {
        type: 'split',
        direction: 'horizontal',
        first: leaf(NEW_LEAF),
        second: leaf(TEST_LEAF_1)
      },
      second: leaf(TEST_LEAF_2)
    }

    await bindNewPane(store, {
      kind: 'split',
      parentLeafId: TEST_LEAF_1,
      direction: 'horizontal',
      proposedRoot
    })

    expect(root(store)).toEqual(proposedRoot)
  })

  it('ignores a window tree that moved other panes, and splits the named pane instead', async () => {
    const store = createStore()
    seedTwoPaneTab(store)

    await bindNewPane(store, {
      kind: 'split',
      parentLeafId: TEST_LEAF_2,
      direction: 'horizontal',
      proposedRoot: {
        type: 'split',
        direction: 'horizontal',
        first: {
          type: 'split',
          direction: 'vertical',
          first: leaf(TEST_LEAF_2),
          second: leaf(TEST_LEAF_1)
        },
        second: leaf(NEW_LEAF)
      }
    })

    expect(root(store)).toEqual({
      type: 'split',
      direction: 'vertical',
      first: leaf(TEST_LEAF_1),
      second: {
        type: 'split',
        direction: 'horizontal',
        first: leaf(TEST_LEAF_2),
        second: leaf(NEW_LEAF)
      }
    })
  })

  it("takes the window's split of a group of panes, keeping main's divider inside the group", async () => {
    const store = createStore()
    seedTwoPaneTab(store, 0.7)

    await bindNewPane(store, {
      kind: 'split',
      parentLeafId: TEST_LEAF_2,
      direction: 'horizontal',
      ratio: 0.6,
      proposedRoot: {
        type: 'split',
        direction: 'horizontal',
        first: { ...SIDE_BY_SIDE, ratio: 0.5 },
        second: leaf(NEW_LEAF),
        ratio: 0.6
      }
    })

    expect(root(store)).toEqual({
      type: 'split',
      direction: 'horizontal',
      first: { ...SIDE_BY_SIDE, ratio: 0.7 },
      second: leaf(NEW_LEAF),
      ratio: 0.6
    })
  })

  it("keeps main's divider above the window's new split", async () => {
    const store = createStore()
    seedTwoPaneTab(store, 0.7)

    await bindNewPane(store, {
      kind: 'split',
      parentLeafId: TEST_LEAF_1,
      direction: 'horizontal',
      proposedRoot: {
        type: 'split',
        direction: 'vertical',
        first: {
          type: 'split',
          direction: 'horizontal',
          first: leaf(NEW_LEAF),
          second: leaf(TEST_LEAF_1),
          ratio: 0.4
        },
        second: leaf(TEST_LEAF_2),
        ratio: 0.5
      }
    })

    expect(root(store)).toEqual({
      type: 'split',
      direction: 'vertical',
      first: {
        type: 'split',
        direction: 'horizontal',
        first: leaf(NEW_LEAF),
        second: leaf(TEST_LEAF_1),
        ratio: 0.4
      },
      second: leaf(TEST_LEAF_2),
      ratio: 0.7
    })
  })

  it('ignores a window tree holding the new pane twice', async () => {
    const store = createStore()
    seedTwoPaneTab(store)

    await bindNewPane(store, {
      kind: 'split',
      parentLeafId: TEST_LEAF_2,
      direction: 'horizontal',
      proposedRoot: {
        type: 'split',
        direction: 'vertical',
        first: {
          type: 'split',
          direction: 'horizontal',
          first: leaf(TEST_LEAF_1),
          second: leaf(NEW_LEAF)
        },
        second: {
          type: 'split',
          direction: 'horizontal',
          first: leaf(TEST_LEAF_2),
          second: leaf(NEW_LEAF)
        }
      }
    })

    expect(root(store)).toEqual({
      type: 'split',
      direction: 'vertical',
      first: leaf(TEST_LEAF_1),
      second: {
        type: 'split',
        direction: 'horizontal',
        first: leaf(TEST_LEAF_2),
        second: leaf(NEW_LEAF)
      }
    })
  })

  it('falls back to adding the pane beside the whole tree when the named pane is not in it', async () => {
    const store = createStore()
    seedTwoPaneTab(store)

    await bindNewPane(store, { kind: 'split', parentLeafId: UNKNOWN_LEAF, direction: 'horizontal' })

    expect(root(store)).toEqual(WRAPPED_AT_ROOT)
  })

  it('falls back to adding the pane beside the whole tree when the spawn names no split', async () => {
    const store = createStore()
    seedTwoPaneTab(store)

    await bindNewPane(store)

    expect(root(store)).toEqual(WRAPPED_AT_ROOT)
  })
})
