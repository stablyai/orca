import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'
import { UpdatePaneLayout } from '../../shared/rpc-contract/session-tabs-schemas-params'
import type { RuntimeStore } from './runtime-store-contract'

describe('remote terminal chat ownership', () => {
  it('preserves, changes, and explicitly clears the owner across the RPC and restart boundary', async () => {
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
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
    await update(HEADLESS_LEAF_ID)
    expect(getSession().terminalLayoutsByTabId['host-tab']?.chatLeafId).toBe(HEADLESS_LEAF_ID)
    // An older client changing geometry must not clear the owner.
    await update(undefined)
    expect(getSession().terminalLayoutsByTabId['host-tab']?.chatLeafId).toBe(HEADLESS_LEAF_ID)
    runtime['mobileSessionTabsByWorktree'].delete(TEST_WORKTREE_ID)
    runtime['hydrateHeadlessMobileSessionTabsFromWorkspaceSession'](TEST_WORKTREE_ID)
    const rehydrated = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const surface = rehydrated.tabs.find(
      (tab) => tab.type === 'terminal' && tab.parentTabId === 'host-tab'
    )
    expect(surface?.type === 'terminal' && surface.parentLayout?.chatLeafId).toBe(HEADLESS_LEAF_ID)
    await update(null)
    expect(getSession().terminalLayoutsByTabId['host-tab']?.chatLeafId).toBeUndefined()
    const cleared = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(
      cleared.tabs
        .filter((tab) => tab.type === 'terminal')
        .every((tab) => !tab.parentLayout?.chatLeafId)
    ).toBe(true)
  })
})
