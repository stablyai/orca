import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../orca-runtime-test-fixtures.spec'

// #29975: paired desktops prefer saved names; publish CLI-renamed headless titles as manual.
function headlessRuntime() {
  const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal()
  )
  return { runtime: new OrcaRuntimeService(runtimeStore), getSession }
}

describe('headless terminal rename publication', () => {
  async function renamedRuntime() {
    const { runtime } = headlessRuntime()
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: 'rename-pty' })),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      activate: true
    })
    return { runtime, handle: created.handle }
  }

  async function publishedSurface(runtime: OrcaRuntimeService) {
    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const surface = listed.tabs.find(
      (tab) => tab.type === 'terminal' && tab.parentTabId === 'host-tab'
    )
    return surface?.type === 'terminal' ? surface : undefined
  }

  it('publishes the manual name on the live surface without a cold rehydrate', async () => {
    const { runtime, handle } = await renamedRuntime()

    await runtime.renameTerminal(handle, 'Codex · 绑定实现')

    expect(await publishedSurface(runtime)).toMatchObject({
      title: 'Codex · 绑定实现',
      customTitle: 'Codex · 绑定实现'
    })
  })

  it('names a tab with no live pane by its tab id, and persists it', async () => {
    const { runtime, getSession } = headlessRuntime()
    runtime['hydrateHeadlessMobileSessionTabsFromWorkspaceSession'](TEST_WORKTREE_ID)

    await runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      customTitle: '  Sleeping  '
    })

    // Phones/older desktops read only title.
    expect(await publishedSurface(runtime)).toMatchObject({
      title: 'Sleeping',
      customTitle: 'Sleeping'
    })
    expect(
      getSession().tabsByWorktree[TEST_WORKTREE_ID]!.find((tab) => tab.id === 'host-tab')
        ?.customTitle
    ).toBe('Sleeping')
  })

  it('restores the saved title when a tab-id rename is cleared', async () => {
    const { runtime } = headlessRuntime()
    runtime['hydrateHeadlessMobileSessionTabsFromWorkspaceSession'](TEST_WORKTREE_ID)
    const before = (await publishedSurface(runtime))?.title
    const worktree = `id:${TEST_WORKTREE_ID}`
    await runtime.setMobileSessionTabProps(worktree, { tabId: 'host-tab', customTitle: 'X' })

    await runtime.setMobileSessionTabProps(worktree, { tabId: 'host-tab', customTitle: null })

    expect(await publishedSurface(runtime)).toMatchObject({ title: before, customTitle: null })
  })

  it('names and clears a live pane through its tab id as terminal.rename does', async () => {
    const { runtime, handle } = await renamedRuntime()
    const worktree = `id:${TEST_WORKTREE_ID}`
    await runtime.renameTerminal(handle, 'By handle')

    await runtime.setMobileSessionTabProps(worktree, { tabId: 'host-tab', customTitle: 'By tab' })
    expect(await publishedSurface(runtime)).toMatchObject({
      title: 'By tab',
      customTitle: 'By tab'
    })

    await runtime.setMobileSessionTabProps(worktree, { tabId: 'host-tab', customTitle: null })
    const cleared = await publishedSurface(runtime)
    expect(cleared?.customTitle).toBeNull()
    expect(cleared?.title).not.toBe('By tab')
  })

  it('drops a name set while the pane slept when its handle is reset', async () => {
    const { runtime } = headlessRuntime()
    runtime['hydrateHeadlessMobileSessionTabsFromWorkspaceSession'](TEST_WORKTREE_ID)
    await runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      customTitle: 'Asleep name'
    })
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: 'wake-pty' })),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const woken = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      activate: true
    })

    await runtime.renameTerminal(woken.handle, null)

    const surface = await publishedSurface(runtime)
    expect(surface?.customTitle).toBeNull()
    expect(surface?.title).not.toBe('Asleep name')
  })

  it('publishes a cleared name as null so clients drop theirs', async () => {
    const { runtime, handle } = await renamedRuntime()
    await runtime.renameTerminal(handle, 'Pinned')

    await runtime.renameTerminal(handle, null)

    expect(await publishedSurface(runtime)).toMatchObject({ customTitle: null })
  })
})
