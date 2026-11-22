import { afterEach, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { retirePersistedStablePaneOwner } from '../../../ipc/pty/pane/stable-owner'
import { TEST_LEAF_1, TEST_LEAF_2 } from '../../persistence-session-fixtures'
import { fixture } from '../profile-writing/profile-state-delayed-authority-fixture'

// Perf contract (#44641): a PTY bind or retire on main copied the whole session for rollback (~110-130 ms
// per terminal spawn at a 10M-char session). Neither may copy the session (base: 8 copies here).

const clone = globalThis.structuredClone

afterEach(() => {
  vi.restoreAllMocks()
})

function seededSession(session: WorkspaceSessionState, worktrees: number): WorkspaceSessionState {
  const tabsByWorktree: WorkspaceSessionState['tabsByWorktree'] = {}
  const terminalLayoutsByTabId: WorkspaceSessionState['terminalLayoutsByTabId'] = {}
  for (let index = 0; index < worktrees; index++) {
    const worktreeId = `repo-local::/fixture/w${index}`
    const tabId = `tab-${index}`
    tabsByWorktree[worktreeId] = [
      {
        id: tabId,
        ptyId: `pty-${index}`,
        worktreeId,
        title: 'Terminal 1',
        defaultTitle: 'Terminal 1',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
    ]
    terminalLayoutsByTabId[tabId] = {
      root: { type: 'leaf', leafId: TEST_LEAF_1 },
      activeLeafId: TEST_LEAF_1,
      expandedLeafId: null,
      ptyIdsByLeafId: { [TEST_LEAF_1]: `pty-${index}` }
    }
  }
  return { ...session, tabsByWorktree, terminalLayoutsByTabId }
}

async function wholeSessionCopiesPerBindAndRetire(worktrees: number): Promise<number> {
  const { store } = await fixture()
  store.setWorkspaceSession(seededSession(store.getWorkspaceSession(), worktrees))
  await store.flushPendingOrThrowAsync()
  let copies = 0
  const spy = vi.spyOn(globalThis, 'structuredClone').mockImplementation((value, options) => {
    if (typeof value === 'object' && value !== null && 'tabsByWorktree' in value) {
      copies += 1
    }
    return clone(value, options)
  })
  const binding = {
    worktreeId: 'repo-local::/fixture/w0',
    tabId: 'tab-0',
    leafId: TEST_LEAF_2,
    ptyId: 'pty-new',
    incarnationId: 'incarnation-new'
  }
  expect(await store.persistPtyBinding(binding)).toBe(true)
  expect(await store.retirePtyBinding(binding)).toBe(true)
  expect(await store.persistPtyBinding(binding)).toBe(true)
  expect(
    await retirePersistedStablePaneOwner(
      store,
      { ...binding, persistedIncarnationId: binding.incarnationId },
      binding.worktreeId,
      undefined
    )
  ).toBe(true)
  spy.mockRestore()
  return copies
}

it('copies no whole session per PTY bind or retire at N and 10N workspaces', async () => {
  expect(await wholeSessionCopiesPerBindAndRetire(200)).toBe(0)
  expect(await wholeSessionCopiesPerBindAndRetire(2_000)).toBe(0)
})
