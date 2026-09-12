import { expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { store, TEST_WORKTREE_ID } = await import('./orca-runtime-test-fixtures.spec')

it.each(['renderer:active-generation', 'headless:active-generation'])(
  'keeps %s live when runtime-owned creation supplements its inventory',
  async (publicationEpoch) => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-runtime-fallback' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch,
          snapshotVersion: 7,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]
    })
    const events: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged(
      (snapshot) => events.push(snapshot),
      'paired-client'
    )
    try {
      const created = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        activate: false,
        select: false,
        navigation: 'caller',
        clientNavigationId: 'paired-client'
      })
      expect(created.tab.status).toBe('ready')
      expect(created.publicationEpoch).toBe(publicationEpoch)
      expect(created.snapshotVersion).toBeGreaterThan(7)
      expect(events.at(-1)).toMatchObject({
        publicationEpoch: `${publicationEpoch}:client-navigation`,
        tabs: [expect.objectContaining({ id: created.tab.id, status: 'ready' })]
      })
    } finally {
      unsubscribe()
    }
  }
)
