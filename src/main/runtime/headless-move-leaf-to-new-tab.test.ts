import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'
import type { RuntimeStore } from './runtime-store-contract'
import { planTerminalLeafMove } from '../persistence/terminal-topology/terminal-leaf-move'
import type { TerminalLeafMoveRequest } from '../../shared/terminal-leaf-move'

const SIBLING_LEAF_ID = '33333333-3333-4333-8333-333333333333'
async function setup() {
  const base = makeWorkspaceSessionWithHeadlessTerminal()
  const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession({
    ...base,
    terminalLayoutsByTabId: {
      'host-tab': {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: HEADLESS_LEAF_ID },
          second: { type: 'leaf', leafId: SIBLING_LEAF_ID }
        },
        activeLeafId: HEADLESS_LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [HEADLESS_LEAF_ID]: 'persisted-pty', [SIBLING_LEAF_ID]: 'sibling-pty' }
      }
    }
  })
  // The host's real planner over the shared session, as Store.moveTerminalLeafToNewTab runs it.
  const commit = vi.fn(async (request: TerminalLeafMoveRequest) => {
    const plan = planTerminalLeafMove([{ hostId: 'local', session: getSession() }], request)
    if (plan.sessions[0]) {
      setSession(plan.sessions[0].session)
    }
    return plan.result
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The shared fixture implements RuntimeStore for this runtime.
  const runtime = new OrcaRuntimeService(runtimeStore as RuntimeStore)
  await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
  const published: unknown[] = []
  runtime.onMobileSessionTabsChanged((snapshot) => published.push(snapshot))
  const move = (targetTabId = 'host-new-tab') =>
    runtime.moveMobileSessionLeafToNewTab(
      `id:${TEST_WORKTREE_ID}`,
      { sourceTabId: 'host-tab', targetTabId, leafId: SIBLING_LEAF_ID },
      commit
    )
  return { runtime, getSession, published, commit, move }
}
describe('moveMobileSessionLeafToNewTab on a headless host', () => {
  it('commits the move, and republishes the tabs with the leaf in its new tab', async () => {
    const { runtime, getSession, published, commit, move } = await setup()
    await expect(move()).resolves.toEqual({ status: 'moved', ptyId: 'sibling-pty' })
    const layouts = getSession().terminalLayoutsByTabId
    expect(layouts['host-new-tab']?.root).toEqual({ type: 'leaf', leafId: SIBLING_LEAF_ID })
    expect(layouts['host-tab']?.root).toEqual({ type: 'leaf', leafId: HEADLESS_LEAF_ID })
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({ targetTabId: 'host-new-tab', ptyId: null })
    )
    expect(published).toHaveLength(1)
    const { tabs } = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const parentOf = (leafId: string) =>
      tabs.flatMap((tab) =>
        tab.type === 'terminal' && tab.leafId === leafId ? [tab.parentTabId] : []
      )
    expect(parentOf(SIBLING_LEAF_ID)).toEqual(['host-new-tab'])
    expect(parentOf(HEADLESS_LEAF_ID)).toEqual(['host-tab'])
  })
  it('refuses a target tab id a pane key cannot carry, leaving the session alone', async () => {
    const { getSession, published, commit, move } = await setup()
    const before = getSession()
    await expect(move('bad:tab')).resolves.toEqual({ status: 'refused', reason: 'invalid_request' })
    expect(getSession()).toBe(before)
    expect(commit).not.toHaveBeenCalled()
    expect(published).toHaveLength(0)
  })
})
