import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/orca-profiles/constants'
import { mintServePtySessionId } from '../../../../shared/terminal/pty/lifecycle/pty-session-id-format'
import { Store } from '../../../persistence/loading-store/store'
import {
  closeTestStores,
  createSqliteTestStore
} from '../../../persistence/persistence-test-harness'
import { commitLeafMoveAndRekey } from '../../../ipc/pty/ipc/leaf-move'
import { OrcaRuntimeService } from '../../orca-runtime'

const WT = 'repo1::/tmp/move-pin-worktree'
const SELECTOR = `id:${WT}`
const TAB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TAB_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SOURCE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const TARGET = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const STAY = '33333333-3333-4333-8333-333333333333'
const MOVE = '44444444-4444-4444-8444-444444444444'
const pty = (leafId: string) => mintServePtySessionId(WT, leafId)

let directory: string | undefined

afterEach(async () => {
  await closeTestStores()
  if (directory) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function terminalTab(id: string, ptyId: string, sortOrder: number) {
  return {
    id,
    worktreeId: WT,
    ptyId,
    title: `Terminal ${sortOrder + 1}`,
    customTitle: null,
    color: null,
    sortOrder,
    createdAt: sortOrder + 1
  }
}

function singleLeaf(leafId: string) {
  return {
    root: { type: 'leaf' as const, leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: { [leafId]: pty(leafId) }
  }
}

/** A windowless host serving three terminal tabs; the last is split. */
async function createHost() {
  directory = mkdtempSync(join(tmpdir(), 'orca-move-pin-'))
  const store = createSqliteTestStore(Store, { dataFile: join(directory, 'orca-data.json') })
  store.addRepo({
    id: 'repo1',
    path: '/tmp/move-pin-worktree',
    displayName: 'Fixture',
    badgeColor: 'gray',
    addedAt: 1
  })
  store.setWorkspaceSession({
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WT]: [
        terminalTab(TAB_A, pty(LEAF_A), 0),
        terminalTab(TAB_B, pty(LEAF_B), 1),
        terminalTab(SOURCE, pty(STAY), 2)
      ]
    },
    terminalLayoutsByTabId: {
      [TAB_A]: singleLeaf(LEAF_A),
      [TAB_B]: singleLeaf(LEAF_B),
      [SOURCE]: {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: STAY },
          second: { type: 'leaf', leafId: MOVE }
        },
        activeLeafId: MOVE,
        expandedLeafId: null,
        ptyIdsByLeafId: { [STAY]: pty(STAY), [MOVE]: pty(MOVE) }
      }
    }
  })
  const runtime = new OrcaRuntimeService(store)
  for (const [tabId, leafId] of [
    [TAB_A, LEAF_A],
    [TAB_B, LEAF_B],
    [SOURCE, STAY],
    [SOURCE, MOVE]
  ] as const) {
    runtime.registerPty(pty(leafId), WT, null, { tabId, leafId })
  }
  return { store, runtime }
}

describe('a headless host placing a moved pane tab', () => {
  it('stores and publishes it after every pinned tab, wherever the pin sits', async () => {
    const { store, runtime } = await createHost()
    const before = await runtime.listMobileSessionTabs(SELECTOR)
    const groupId = before.tabGroups?.[0]?.id
    expect(before.tabGroups?.[0]?.tabOrder).toEqual([TAB_A, TAB_B, SOURCE])
    // The ordinary pin: B is pinned where it stands, behind unpinned A.
    await runtime.setMobileSessionTabProps(SELECTOR, { tabId: TAB_B, isPinned: true })

    // The client asks for the gap at the front.
    const moved = await runtime.moveMobileSessionLeafToNewTab(
      SELECTOR,
      { sourceTabId: SOURCE, targetTabId: TARGET, leafId: MOVE },
      (move) => commitLeafMoveAndRekey({ store, runtime }, move),
      { targetGroupId: groupId!, index: 0 }
    )

    expect(moved).toMatchObject({ status: 'moved' })
    const published = await runtime.listMobileSessionTabs(SELECTOR)
    const pinned = new Set(published.tabs.filter((tab) => tab.isPinned).map((tab) => tab.id))
    expect(pinned.size).toBeGreaterThan(0)
    const publishedOrder = published.tabGroups?.[0]?.tabOrder ?? []
    const storedOrder = store.getWorkspaceSession().tabGroups?.[WT]?.[0]?.tabOrder ?? []
    for (const order of [publishedOrder, storedOrder]) {
      expect(order.indexOf(TARGET)).toBeGreaterThan(order.indexOf(TAB_B))
    }
  })
})
