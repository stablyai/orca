import { describe, expect, it, vi } from 'vitest'
import '../orca-runtime-tests/runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'

import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../orca-runtime-tests/orca-runtime-test-fixtures.spec'
import type { RuntimeStore } from '../construction/runtime-store-contract'

import { planTerminalLeafMove } from '../../persistence/terminal-topology/terminal-leaf-move'
import type { TerminalLeafMoveRequest } from '../../../shared/workspace-layout/terminal-leaf-move'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import type { Tab } from '../../../shared/tab-types'
import { ownedEditorFileId } from '../../../shared/workspace-session/workspace-session-pane-ownership'

const SIBLING_LEAF_ID = '33333333-3333-4333-8333-333333333333'
const OTHER_LEAF_ID = '44444444-4444-4444-8444-444444444444'
async function setup(
  withSession: (session: WorkspaceSessionState) => WorkspaceSessionState = (session) => session,
  /** Runs while the move's commit is pending, as another writer would. */
  duringCommit: (session: WorkspaceSessionState) => WorkspaceSessionState = (session) => session
) {
  const base = makeWorkspaceSessionWithHeadlessTerminal()
  const hostTab = base.tabsByWorktree[TEST_WORKTREE_ID]![0]!
  const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession(
    withSession({
      ...base,
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          hostTab,
          { ...hostTab, id: 'other-tab', ptyId: 'other-pty', title: 'Other', sortOrder: 1 }
        ]
      },
      terminalLayoutsByTabId: {
        'other-tab': {
          root: { type: 'leaf', leafId: OTHER_LEAF_ID },
          activeLeafId: OTHER_LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [OTHER_LEAF_ID]: 'other-pty' }
        },
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
  )
  // The host's real planner over the shared session, as Store.moveTerminalLeafToNewTab runs it.
  const commit = vi.fn(async (request: TerminalLeafMoveRequest) => {
    setSession(duringCommit(getSession()))
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
  const move = (
    targetTabId = 'host-new-tab',
    placement?: Parameters<typeof runtime.moveMobileSessionLeafToNewTab>[3]
  ) =>
    runtime.moveMobileSessionLeafToNewTab(
      `id:${TEST_WORKTREE_ID}`,
      { sourceTabId: 'host-tab', targetTabId, leafId: SIBLING_LEAF_ID },
      commit,
      placement
    )
  return { runtime, getSession, published, commit, move }
}
describe('moveMobileSessionLeafToNewTab on a headless host', () => {
  it('moves the live terminal with its pane, so tab-scoped reads find it in the new tab', async () => {
    const { runtime, move } = await setup()
    runtime.registerPty('sibling-pty', TEST_WORKTREE_ID, null, {
      tabId: 'host-tab',
      leafId: SIBLING_LEAF_ID
    })
    await expect(move()).resolves.toEqual({ status: 'moved', ptyId: 'sibling-pty' })
    const { terminals } = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(terminals.find((terminal) => terminal.leafId === SIBLING_LEAF_ID)?.tabId).toBe(
      'host-new-tab'
    )
  })
  it('keeps a tab opened while the move commits, after the tabs the user had', async () => {
    const { runtime, move } = await setup(withFileBetweenTerminals, withLateTerminal)
    const worktree = `id:${TEST_WORKTREE_ID}`
    const listed = async () => (await runtime.listMobileSessionTabs(worktree)).tabGroups?.[0]
    const group = (await listed())!
    const file = group.tabOrder.find((id) => id !== 'host-tab' && id !== 'other-tab')!
    await runtime.moveMobileSessionTab(worktree, {
      kind: 'reorder',
      tabId: file,
      targetGroupId: group.id,
      tabOrder: ['host-tab', file, 'other-tab']
    })
    await move('host-new-tab', { targetGroupId: group.id, index: 2 })
    expect((await listed())?.tabOrder).toEqual([
      'host-tab',
      file,
      'host-new-tab',
      'other-tab',
      'late-tab'
    ])
  })
  it('keeps a reorder another client made while the move committed', async () => {
    let reorder: () => Promise<unknown> = async () => {}
    const { runtime, move } = await setup(undefined, (session) => {
      void reorder()
      return session
    })
    const worktree = `id:${TEST_WORKTREE_ID}`
    const listed = async () => (await runtime.listMobileSessionTabs(worktree)).tabGroups?.[0]
    const group = (await listed())!
    expect(group.tabOrder).toEqual(['host-tab', 'other-tab'])
    reorder = async () => {
      reorder = async () => {}
      await runtime.moveMobileSessionTab(worktree, {
        kind: 'reorder',
        tabId: 'other-tab',
        targetGroupId: group.id,
        tabOrder: ['other-tab', 'host-tab']
      })
    }
    await move('host-new-tab', { targetGroupId: group.id, index: 0 })
    expect((await listed())?.tabOrder).toEqual(['host-new-tab', 'other-tab', 'host-tab'])
  })
  it('refuses a move that would empty its source, which no headless cleanup retires', async () => {
    const { runtime, getSession, published, move } = await setup(undefined, (session) => ({
      ...session,
      terminalLayoutsByTabId: {
        ...session.terminalLayoutsByTabId,
        'host-tab': {
          root: { type: 'leaf', leafId: SIBLING_LEAF_ID },
          activeLeafId: SIBLING_LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [SIBLING_LEAF_ID]: 'sibling-pty' }
        }
      }
    }))
    await expect(move()).resolves.toEqual({ status: 'refused', reason: 'last_pane' })
    expect(getSession().terminalLayoutsByTabId['host-tab']?.root).toEqual({
      type: 'leaf',
      leafId: SIBLING_LEAF_ID
    })
    expect(published).toHaveLength(0)
    const { tabs } = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(tabs.some((tab) => tab.type === 'terminal' && tab.parentTabId === 'host-new-tab')).toBe(
      false
    )
  })
})

/** A session whose worktree also has an editor open beside its two terminal tabs. */
function withFileBetweenTerminals(session: WorkspaceSessionState): WorkspaceSessionState {
  const filePath = '/repo/notes.ts'
  const entry = (
    id: string,
    entityId: string,
    contentType: Tab['contentType'],
    sortOrder: number
  ) => ({
    id,
    entityId,
    groupId: 'group-1',
    worktreeId: TEST_WORKTREE_ID,
    contentType,
    label: id,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: 1
  })
  return {
    ...session,
    openFilesByWorktree: {
      [TEST_WORKTREE_ID]: [
        { filePath, relativePath: 'notes.ts', worktreeId: TEST_WORKTREE_ID, language: 'typescript' }
      ]
    },
    unifiedTabs: {
      [TEST_WORKTREE_ID]: [
        entry('host-tab', 'host-tab', 'terminal', 0),
        entry('file-tab', ownedEditorFileId(filePath, TEST_WORKTREE_ID, undefined), 'editor', 1),
        entry('other-tab', 'other-tab', 'terminal', 2)
      ]
    },
    tabGroups: {
      [TEST_WORKTREE_ID]: [
        {
          id: 'group-1',
          worktreeId: TEST_WORKTREE_ID,
          activeTabId: 'host-tab',
          tabOrder: ['host-tab', 'file-tab', 'other-tab']
        }
      ]
    }
  }
}

const LATE_LEAF_ID = '55555555-5555-4555-8555-555555555555'

/** A terminal tab another writer opens while the move's commit is pending. */
function withLateTerminal(session: WorkspaceSessionState): WorkspaceSessionState {
  const tabs = session.tabsByWorktree[TEST_WORKTREE_ID] ?? []
  if (tabs.some((tab) => tab.id === 'late-tab')) {
    return session
  }
  return {
    ...session,
    tabsByWorktree: {
      ...session.tabsByWorktree,
      [TEST_WORKTREE_ID]: [
        ...tabs,
        { ...tabs[0]!, id: 'late-tab', ptyId: 'late-pty', title: 'Late', sortOrder: 9 }
      ]
    },
    terminalLayoutsByTabId: {
      ...session.terminalLayoutsByTabId,
      'late-tab': {
        root: { type: 'leaf', leafId: LATE_LEAF_ID },
        activeLeafId: LATE_LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LATE_LEAF_ID]: 'late-pty' }
      }
    }
  }
}
