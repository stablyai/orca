import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPageInventoryEntry } from '../../../shared/browser/runtime/browser-page-inventory'
import { browserPageInventorySchema } from '../../../shared/browser/runtime/browser-page-inventory'
import type { RuntimeMobileSessionTabsPublication } from '../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { RuntimeStore } from '../construction/runtime-store-contract'
import { AgentBrowserBridge } from '../../browser/agent-browser/agent-browser-bridge'
import '../orca-runtime-tests/orca-runtime-test-lifecycle.spec'
import {
  store,
  makeWorktreeMeta,
  TEST_WORKTREE_ID
} from '../orca-runtime-tests/orca-runtime-test-fixtures.spec'
import { OrcaRuntimeService } from '../orca-runtime'

const WT = TEST_WORKTREE_ID
const EPOCH = 'renderer:inventory-epoch'

function entry(id: string): BrowserPageInventoryEntry {
  return {
    browserPageId: id,
    browserWorkspaceId: 'browser-1',
    title: `Page ${id}`,
    url: `https://${id}.example/`,
    profileId: 'default',
    loadError: null,
    certificateFailure: null
  }
}

function frame(
  version: number,
  extra: Partial<RuntimeMobileSessionTabsPublication> = {}
): RuntimeMobileSessionTabsPublication {
  return {
    worktree: WT,
    worktreeInstanceId: 'occupant-1',
    publicationEpoch: EPOCH,
    snapshotVersion: version,
    activeGroupId: null,
    activeTabId: 'tab-1::leaf-1',
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: 'tab-1::leaf-1',
        parentTabId: 'tab-1',
        leafId: 'leaf-1',
        title: `Terminal v${version}`,
        isActive: true
      }
    ],
    ...extra
  }
}

function createRuntime() {
  let meta: WorktreeMeta | undefined = makeWorktreeMeta({ instanceId: 'occupant-1' })
  const runtimeStore: RuntimeStore = {
    ...store,
    getWorktreeMeta: () => meta,
    getAllWorktreeMeta: (): Record<string, WorktreeMeta> => (meta ? { [WT]: meta } : {}),
    setWorktreeMeta: (_target, updates) => {
      meta = { ...makeWorktreeMeta(), ...meta, ...updates }
      return meta
    },
    removeWorktreeMeta: () => {
      meta = undefined
    }
  }
  const runtime = new OrcaRuntimeService(runtimeStore)
  runtime.attachWindow(1)
  const bridge = vi.mockObject(AgentBrowserBridge.prototype)
  bridge.getRegisteredTabs.mockReturnValue(new Map())
  bridge.tabList.mockReturnValue({ tabs: [] })
  runtime.setAgentBrowserBridge(bridge)
  const sync = (...frames: RuntimeMobileSessionTabsPublication[]) =>
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: frames })
  return {
    runtime,
    sync,
    list: () => runtime.browserTabList({ worktree: `id:${WT}` }),
    mobile: () => runtime.listMobileSessionTabs(`id:${WT}`),
    recreate: (instanceId: string) => {
      meta = makeWorktreeMeta({ instanceId })
    },
    remove: () => runtime.removeWorktreeMetadataAndHistory(runtimeStore, WT)
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('acknowledged browser page inventory base', () => {
  it.each([
    [10, 'saved-9', 'Page saved-9'],
    [100, 'saved-99', 'Page saved-99']
  ] as const)(
    'avoids rescanning %i saved pages across repeated acknowledged syncs',
    async (count, lastPageId, lastTitle) => {
      const { runtime, sync, list, mobile } = createRuntime()
      let pageReads = 0
      const inventory = Array.from({ length: count }, (_, index) => ({
        ...entry(`saved-${index}`),
        get browserPageId() {
          pageReads++
          return `saved-${index}`
        }
      }))
      await sync(frame(1, { browserPageInventory: inventory }))
      runtime.storeMobileSessionSnapshot(WT, frame(100, { browserPageInventory: inventory }))
      const validate = vi.spyOn(browserPageInventorySchema, 'safeParse')
      pageReads = 0

      for (let version = 2; version <= 11; version++) {
        expect(
          (await sync(frame(version, { browserPageInventoryBaseVersion: version - 1 })))
            .mobileSessionResyncWorktrees
        ).toBeUndefined()
      }

      // N/10N contract: terminal-only publications must not revalidate the saved-page array.
      expect(validate).not.toHaveBeenCalled()
      expect(pageReads).toBe(0)
      const pages = (await list()).tabs
      expect(pages).toHaveLength(count)
      expect(pages[0]).toMatchObject({ browserPageId: 'saved-0', title: 'Page saved-0' })
      expect(pages.at(-1)).toMatchObject({ browserPageId: lastPageId, title: lastTitle })
      expect((await mobile()).tabs[0]).toMatchObject({ title: 'Terminal v11' })
      expect((await mobile()).snapshotVersion).toBeGreaterThan(100)
    }
  )

  it('reuses an authoritative empty inventory after replacing saved pages', async () => {
    const { sync, list, mobile } = createRuntime()
    await sync(frame(1, { browserPageInventory: [entry('a'), entry('b')] }))
    await sync(frame(2, { browserPageInventory: [] }))
    expect(
      (await sync(frame(3, { browserPageInventoryBaseVersion: 2 }))).mobileSessionResyncWorktrees
    ).toBeUndefined()
    expect((await list()).tabs).toEqual([])
    expect((await mobile()).tabs[0]).toMatchObject({ title: 'Terminal v3' })
  })

  it.each([
    ['a wrong base', frame(3, { browserPageInventoryBaseVersion: 1 })],
    [
      'another publication epoch',
      frame(3, { publicationEpoch: 'renderer:reloaded', browserPageInventoryBaseVersion: 2 })
    ],
    [
      'another occupant',
      frame(3, { worktreeInstanceId: 'occupant-2', browserPageInventoryBaseVersion: 2 })
    ]
  ])(
    'requests a full resend for %s without losing the accepted catalog',
    async (_label, mismatched) => {
      const { sync, list, mobile } = createRuntime()
      await sync(frame(1, { browserPageInventory: [entry('old')] }))
      await sync(frame(2, { browserPageInventory: [entry('a'), entry('b')] }))

      expect((await sync(mismatched)).mobileSessionResyncWorktrees).toEqual([WT])
      expect((await list()).tabs.map((page) => page.browserPageId)).toEqual(['a', 'b'])
      expect((await mobile()).tabs[0]).toMatchObject({ title: 'Terminal v2' })

      const { browserPageInventoryBaseVersion: _base, ...full } = mismatched
      expect(
        (await sync({ ...full, browserPageInventory: [entry('z')] })).mobileSessionResyncWorktrees
      ).toBeUndefined()
      expect((await list()).tabs.map((page) => page.browserPageId)).toEqual(['z'])
      expect(
        (
          await sync({
            ...full,
            snapshotVersion: 4,
            browserPageInventoryBaseVersion: 3
          })
        ).mobileSessionResyncWorktrees
      ).toBeUndefined()
    }
  )

  it('requests inventory when the acknowledged renderer publication carried none', async () => {
    const { sync, mobile } = createRuntime()
    await sync(frame(1))
    expect((await sync(frame(2))).mobileSessionResyncWorktrees).toBeUndefined()
    expect(
      (await sync(frame(3, { browserPageInventoryBaseVersion: 2 }))).mobileSessionResyncWorktrees
    ).toEqual([WT])
    expect((await mobile()).tabs[0]).toMatchObject({ title: 'Terminal v2' })
  })

  it('accepts the next base after a duplicate frame loses its acknowledgement', async () => {
    const { sync, list, mobile } = createRuntime()
    await sync(frame(1, { browserPageInventory: [entry('a')] }))
    await sync(frame(2, { browserPageInventoryBaseVersion: 1 }))
    expect(
      (await sync(frame(2, { browserPageInventoryBaseVersion: 1 }))).mobileSessionResyncWorktrees
    ).toBeUndefined()
    expect(
      (await sync(frame(3, { browserPageInventoryBaseVersion: 2 }))).mobileSessionResyncWorktrees
    ).toBeUndefined()
    expect((await mobile()).tabs[0]).toMatchObject({ title: 'Terminal v3' })
    expect((await list()).tabs.map((page) => page.browserPageId)).toEqual(['a'])
  })

  it('fences a removed occupant and makes its successor resend in full', async () => {
    const { sync, list, recreate, remove } = createRuntime()
    await sync(frame(1, { browserPageInventory: [entry('a')] }))
    await remove()
    recreate('occupant-2')
    expect(
      (await sync(frame(2, { browserPageInventoryBaseVersion: 1 }))).mobileSessionResyncWorktrees
    ).toBeUndefined()
    expect((await list()).tabs).toEqual([])

    const successor = { worktreeInstanceId: 'occupant-2' }
    expect(
      (await sync(frame(3, { ...successor, browserPageInventoryBaseVersion: 1 })))
        .mobileSessionResyncWorktrees
    ).toEqual([WT])
    expect((await list()).tabs).toEqual([])
    await sync(frame(3, { ...successor, browserPageInventory: [entry('b')] }))
    expect((await list()).tabs.map((page) => page.browserPageId)).toEqual(['b'])
  })

  it.each([
    [
      'an inventory beside a base',
      { browserPageInventory: [entry('a')], browserPageInventoryBaseVersion: 1 }
    ],
    ['a fractional base', { browserPageInventoryBaseVersion: 1.5 }]
  ])('rejects %s without replacing the accepted catalog', async (_label, malformed) => {
    const { sync, list } = createRuntime()
    await sync(frame(1, { browserPageInventory: [entry('a')] }))
    await expect(sync(frame(2, malformed))).rejects.toThrow('invalid_browser_page_inventory')
    expect((await list()).tabs.map((page) => page.browserPageId)).toEqual(['a'])
  })
})
