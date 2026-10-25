// Layout-owner build: attaching the hook server's store also follows its rows for main's tab titles.
import { describe, expect, it, vi } from 'vitest'
import { setupMainOwnedWorkspace } from './main-owned-workspace-runtime-fixture'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

function hookStore() {
  const unsubscribe = vi.fn()
  return {
    unsubscribe,
    getStatusSnapshot: () => [],
    getStatusSnapshotForPane: () => [],
    subscribeStatusRowMutations: () => () => {},
    subscribeStatusFreshness: () => () => {},
    subscribeEnrichedStatus: vi.fn(() => unsubscribe)
  }
}

describe("main's tab titles from the attached hook store", () => {
  it('subscribes once to enriched status and unsubscribes on detach', () => {
    const { runtime } = setupMainOwnedWorkspace()
    const store = hookStore()

    const detach = runtime.attachAgentStatusStore(store)
    expect(store.subscribeEnrichedStatus).toHaveBeenCalledOnce()
    detach()

    expect(store.unsubscribe).toHaveBeenCalledOnce()
  })
})
