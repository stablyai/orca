import { expect, it, vi } from 'vitest'
import { fixture } from '../../../persistence/loading-store/profile-state-delayed-authority-fixture'
import { TEST_LEAF_1, TEST_LEAF_2 } from '../../../persistence-session-fixtures'
import { swapReplacedPaneBinding, type ReplacedPaneOwner } from './pane-owner-replacement'

vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const worktreeId = 'repo-local::/fixture/local'
const tabId = 'restart-tab'

function replaced(ptyId: string, hostId?: string): ReplacedPaneOwner {
  return { ptyId, pane: { worktreeId, tabId, leafId: TEST_LEAF_1, hostId } }
}

type FixtureStore = Awaited<ReturnType<typeof fixture>>['store']

/** The binding swap must survive the renderer's own pre-connect clear, which strict fences refuse. */
async function expectSwapAfterRendererClear(
  store: FixtureStore,
  oldId: string,
  newId: string,
  hostId?: string
): Promise<void> {
  expect(
    store.getWorkspaceSession(hostId).terminalLayoutsByTabId[tabId].ptyIdsByLeafId?.[TEST_LEAF_1]
  ).toBeUndefined()
  const binding = { worktreeId, tabId, leafId: TEST_LEAF_1, ptyId: newId, incarnationId: 'inc-new' }
  expect(
    await store.persistPtyBinding(
      { ...binding, expectedBinding: { ptyId: oldId, incarnationId: 'inc-old' } },
      hostId
    )
  ).toBe(false)
  expect(
    await store.persistPtyBinding(
      swapReplacedPaneBinding(store, binding, replaced(oldId, hostId), hostId),
      hostId
    )
  ).toBe(true)
  expect(
    store.getWorkspaceSession(hostId).terminalLayoutsByTabId[tabId].ptyIdsByLeafId?.[TEST_LEAF_1]
  ).toBe(newId)
}

it('swaps a local split pane whose renderer layout patch already dropped the stopped binding', async () => {
  const { store } = await fixture()
  const pane = { worktreeId, tabId }
  await store.persistPtyBinding({
    ...pane,
    leafId: TEST_LEAF_1,
    ptyId: 'old',
    incarnationId: 'inc-old'
  })
  await store.persistPtyBinding({ ...pane, leafId: TEST_LEAF_2, ptyId: 'sibling' })
  const layouts = structuredClone(store.getWorkspaceSession().terminalLayoutsByTabId)
  // The mounted restart clears only its own leaf before connecting; a partial map is honored.
  delete layouts[tabId].ptyIdsByLeafId![TEST_LEAF_1]
  store.patchWorkspaceSession({ terminalLayoutsByTabId: layouts })
  await expectSwapAfterRendererClear(store, 'old', 'new')
  expect(
    store.getWorkspaceSession().terminalLayoutsByTabId[tabId].ptyIdsByLeafId?.[TEST_LEAF_2]
  ).toBe('sibling')
})

it('swaps an SSH pane whose terminated lease let the renderer clear withdraw the binding', async () => {
  const { store } = await fixture()
  const hostId = 'ssh:restart'
  const oldId = 'ssh:restart@@remote-old'
  await store.persistPtyBinding(
    { worktreeId, tabId, leafId: TEST_LEAF_1, ptyId: oldId, incarnationId: 'inc-old' },
    hostId
  )
  store.upsertSshRemotePtyLease({
    targetId: 'restart',
    ptyId: 'remote-old',
    worktreeId,
    tabId,
    leafId: TEST_LEAF_1,
    state: 'attached'
  })
  // What the replacement stop records (finishPtyShutdown).
  store.markSshRemotePtyLease('restart', 'remote-old', 'terminated')
  const layouts = structuredClone(store.getWorkspaceSession(hostId).terminalLayoutsByTabId)
  layouts[tabId].ptyIdsByLeafId = {}
  store.patchWorkspaceSession({ terminalLayoutsByTabId: layouts }, hostId)
  await expectSwapAfterRendererClear(store, oldId, 'ssh:restart@@remote-new', hostId)
})

it('refuses the swap when another owner holds the leaf', async () => {
  const { store } = await fixture()
  await store.persistPtyBinding({ worktreeId, tabId, leafId: TEST_LEAF_1, ptyId: 'successor' })
  const binding = { worktreeId, tabId, leafId: TEST_LEAF_1, ptyId: 'new' }
  expect(
    await store.persistPtyBinding(
      swapReplacedPaneBinding(store, binding, replaced('old'), undefined)
    )
  ).toBe(false)
  expect(
    store.getWorkspaceSession().terminalLayoutsByTabId[tabId].ptyIdsByLeafId?.[TEST_LEAF_1]
  ).toBe('successor')
})
