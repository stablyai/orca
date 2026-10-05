import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'
import { UpdatePaneLayout } from '../../shared/rpc-contract/session-tabs-schemas-params'
import type { RuntimeStore } from './runtime-store-contract'

function makeSplitRuntime() {
  const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal({
      terminalLayoutsByTabId: {
        'host-tab': makeHeadlessTerminalLayout({
          [HEADLESS_LEAF_ID]: 'persisted-pty',
          [HEADLESS_SECOND_LEAF_ID]: undefined
        })
      }
    })
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The shared fixture implements RuntimeStore; its annotation erases the Vitest mock call signatures.
  const runtime = new OrcaRuntimeService(runtimeStore as RuntimeStore)
  const update = (owner: string | null | undefined) => {
    const params = UpdatePaneLayout.parse({
      worktree: `id:${TEST_WORKTREE_ID}`,
      tabId: 'host-tab',
      root: getSession().terminalLayoutsByTabId['host-tab']!.root,
      expandedLeafId: null,
      ...(owner !== undefined ? { chatLeafId: owner } : {})
    })
    return runtime.updateMobileSessionPaneLayout(params.worktree, {
      ...params,
      expandedLeafId: params.expandedLeafId ?? null
    })
  }
  const setView = (tabId: string, viewMode: 'terminal' | 'chat') =>
    runtime.setMobileSessionTabProps(`id:${TEST_WORKTREE_ID}`, { tabId, viewMode })
  const owner = () => getSession().terminalLayoutsByTabId['host-tab']?.chatLeafId
  // An older host's record: chat on a split with no owner (F1 hosts never write this shape).
  const persistOwnerlessChat = () => {
    const session = getSession()
    setSession({
      ...session,
      tabsByWorktree: {
        ...session.tabsByWorktree,
        [TEST_WORKTREE_ID]: session.tabsByWorktree[TEST_WORKTREE_ID]!.map((tab) => ({
          ...tab,
          viewMode: 'chat' as const
        }))
      }
    })
  }
  return { runtime, getSession, update, setView, owner, persistOwnerlessChat }
}

describe('remote terminal chat ownership', () => {
  it('lets a layout push only fill in a missing owner on a chat tab', async () => {
    const { update, owner, persistOwnerlessChat } = makeSplitRuntime()
    // A terminal tab takes no owner from the layout lane.
    await update(HEADLESS_LEAF_ID)
    expect(owner()).toBeUndefined()
    // A chat with no owner accepts the pushed claim.
    persistOwnerlessChat()
    await update(HEADLESS_LEAF_ID)
    expect(owner()).toBe(HEADLESS_LEAF_ID)
    // Stale pushes from any client version can neither move nor clear it.
    await update(HEADLESS_SECOND_LEAF_ID)
    expect(owner()).toBe(HEADLESS_LEAF_ID)
    await update(null)
    expect(owner()).toBe(HEADLESS_LEAF_ID)
    await update(undefined)
    expect(owner()).toBe(HEADLESS_LEAF_ID)
  })

  it('keeps the owner across a restart and clears it only through the pair writer', async () => {
    const { runtime, update, setView, owner, getSession, persistOwnerlessChat } = makeSplitRuntime()
    persistOwnerlessChat()
    await update(HEADLESS_LEAF_ID)
    runtime['mobileSessionTabsByWorktree'].delete(TEST_WORKTREE_ID)
    runtime['hydrateHeadlessMobileSessionTabsFromWorkspaceSession'](TEST_WORKTREE_ID)
    const rehydrated = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const surfaces = rehydrated.tabs.filter((tab) => tab.type === 'terminal')
    expect(surfaces.map((tab) => tab.type === 'terminal' && tab.parentLayout?.chatLeafId)).toEqual([
      HEADLESS_LEAF_ID,
      HEADLESS_LEAF_ID
    ])
    expect(surfaces.map((tab) => tab.type === 'terminal' && tab.viewMode)).toEqual(['chat', 'chat'])

    await setView(`host-tab::${HEADLESS_LEAF_ID}`, 'terminal')
    expect(owner()).toBeUndefined()
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]![0]!.viewMode).toBe('terminal')
    const cleared = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(
      cleared.tabs
        .filter((tab) => tab.type === 'terminal')
        .every((tab) => !tab.parentLayout?.chatLeafId && tab.viewMode === 'terminal')
    ).toBe(true)
  })
})
