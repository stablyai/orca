import { describe, expect, it, vi } from 'vitest'
import type { DurableProfileStateMutation } from '../persistence/loading-store/store-runtime-state'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'
import { partialRuntimeStore } from './runtime-store-partial-fixture'

export function registerHeadlessCloseKeepsPublicationEpochTests(): void {
  /** Closing is not publisher handover: retain the stored epoch.
   * A fresh close epoch retires the renderer's epoch in clients, causing all its later frames to be rejected. */
  const WORKTREE_ID = 'repo-1::/tmp/headless-close'
  const LEAF_ID = '11111111-1111-4111-8111-111111111111'
  const LIVE_EPOCH = 'renderer-generation-1'

  function makeStore() {
    const session = getDefaultWorkspaceSession()
    return {
      getWorkspaceSession: vi.fn(() => session),
      setWorkspaceSession: vi.fn(),
      runDurableMutation: async <T>(mutate: () => DurableProfileStateMutation<T>) => mutate().value,
      getRepos: vi.fn(() => [
        {
          id: 'repo-1',
          path: '/tmp/headless-close',
          displayName: 'headless',
          badgeColor: '#000000',
          addedAt: 0
        }
      ]),
      getAllWorktreeMeta: vi.fn(() => ({})),
      getWorktreeMeta: vi.fn(() => undefined),
      setWorktreeMeta: vi.fn(),
      removeWorktreeMeta: vi.fn(),
      getSettings: vi.fn(() => ({ workspaceDir: '/tmp/workspaces' })),
      getProjects: vi.fn(() => [])
    }
  }

  function terminalTab(parentTabId: string, leafId: string): RuntimeMobileSessionTerminalTab {
    return {
      type: 'terminal',
      id: `${parentTabId}::${leafId}`,
      parentTabId,
      leafId,
      title: 'Terminal',
      isActive: true
    }
  }

  function storedSnapshot(
    tabs: RuntimeMobileSessionTerminalTab[]
  ): RuntimeMobileSessionTabsSnapshot {
    return {
      worktree: WORKTREE_ID,
      publicationEpoch: LIVE_EPOCH,
      snapshotVersion: 4,
      activeGroupId: null,
      activeTabId: `tab-a::${LEAF_ID}`,
      activeTabType: 'terminal',
      tabs
    }
  }

  async function closeOneTab(): Promise<RuntimeMobileSessionTabsSnapshot> {
    const runtime = new OrcaRuntimeService(partialRuntimeStore(makeStore()))
    const closedTab = terminalTab('tab-a', LEAF_ID)
    const snapshot = storedSnapshot([closedTab, terminalTab('tab-b', LEAF_ID)])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: closeHeadlessMobileTerminalTab is protected; reaching it is the only way to drive a headless close.
    const internals = runtime as unknown as {
      closeHeadlessMobileTerminalTab: (
        worktreeId: string,
        snapshot: RuntimeMobileSessionTabsSnapshot,
        tab: RuntimeMobileSessionTerminalTab,
        options?: Record<string, unknown>
      ) => Promise<void>
      mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
    }
    internals.mobileSessionTabsByWorktree.set(WORKTREE_ID, snapshot)
    await internals.closeHeadlessMobileTerminalTab(WORKTREE_ID, snapshot, closedTab, {
      allowMissingPersistedTab: true,
      killPtys: false
    })
    const published = internals.mobileSessionTabsByWorktree.get(WORKTREE_ID)
    if (!published) {
      throw new Error(`the close published no snapshot for ${WORKTREE_ID}`)
    }
    return published
  }

  describe('closing a headless mobile terminal tab', () => {
    it('keeps the worktree under the epoch that was already publishing it', async () => {
      expect((await closeOneTab()).publicationEpoch).toBe(LIVE_EPOCH)
    })

    it('still advances the version so clients accept the frame', async () => {
      const published = await closeOneTab()
      expect(published.snapshotVersion).toBe(5)
      expect(published.tabs.map((tab) => tab.id)).toEqual([`tab-b::${LEAF_ID}`])
    })
  })
}
