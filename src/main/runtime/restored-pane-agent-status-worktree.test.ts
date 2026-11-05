// #38434: clients judge an agent row's ownership by worktree, so a restored pane's status must name it.
import { expect, it } from 'vitest'
import { partialRuntimeStore } from './orca-runtime-tests/runtime-store-partial-fixture'

// Preserve side-effect order: module registration, runtime, lifecycle, fixtures.
await import('./orca-runtime-tests/runtime-test-module-registration.spec')
const { OrcaRuntimeService } = await import('./orca-runtime')
await import('./orca-runtime-tests/orca-runtime-test-lifecycle.spec')
const {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('./orca-runtime-tests/orca-runtime-test-fixtures.spec')

it('names the worktree on a restored pane agent whose hook row carries none', async () => {
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal()
  )
  // Hydrated from the previous run's cache; the hook that reported it named no worktree.
  const rows = [
    {
      paneKey: `host-tab:${HEADLESS_LEAF_ID}`,
      agentType: 'codex' as const,
      providerSession: { key: 'session_id' as const, id: 'codex-session' },
      prompt: 'ship it',
      state: 'working' as const,
      receivedAt: Date.now() - 60_000,
      stateStartedAt: Date.now() - 60_000,
      connectionId: null,
      restoredUnconfirmed: true
    }
  ]
  const runtime = new OrcaRuntimeService(partialRuntimeStore(runtimeStore), undefined, {
    getAgentProviderSessionSnapshot: () => rows,
    getAgentProviderSessionRowsForPane: (paneKey: string) =>
      rows.filter((row) => row.paneKey === paneKey)
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

  const [tab] = (await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs

  expect(tab).toMatchObject({
    status: 'pending-handle',
    agentStatus: { restoredUnconfirmed: true, worktreeId: TEST_WORKTREE_ID }
  })
})
