import './orca-runtime-test-lifecycle.spec'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import {
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession
} from './orca-runtime-test-fixtures.spec'
import { openEditorFileThroughLayoutOwner } from './files/editor-open-through-layout-owner'
import { ownedEditorFileId } from '../../shared/workspace-session-pane-ownership'
import {
  addWorkspace,
  emptySession,
  leaf
} from '../../shared/workspace-layout/workspace-layout-session.test-fixture'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

class RuntimeWithEditorOpenGroup extends OrcaRuntimeService {
  groupForTest(worktreeId: string): string | undefined {
    return this.editorOpenGroupFor(worktreeId)
  }
}

function twoGroupHost() {
  const saved = addWorkspace(emptySession(), TEST_WORKTREE_ID, [
    { id: 'g1', tabs: [{ id: 't1', leaves: [[leaf(1)]] }] },
    { id: 'g2', tabs: [{ id: 't2', leaves: [[leaf(2)]] }] }
  ])
  const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(saved)
  Object.assign(runtimeStore, { getWorkspaceSessionHostIds: () => ['local'] })
  const runtime = new RuntimeWithEditorOpenGroup(runtimeStore)
  const open = () =>
    openEditorFileThroughLayoutOwner(
      {
        applyLayoutCommand: (command) => runtime.applyLayoutCommand(command),
        groupFor: (id) => runtime.groupForTest(id),
        openInWindow: () => {
          throw new Error('opened through the window')
        }
      },
      { worktreeId: TEST_WORKTREE_ID, filePath: '/tmp/worktree-a/a.ts', relativePath: 'a.ts' }
    )
  const groupOfFile = () =>
    getSession().unifiedTabs?.[TEST_WORKTREE_ID]?.find(
      (tab) => tab.entityId === ownedEditorFileId('/tmp/worktree-a/a.ts', TEST_WORKTREE_ID, null)
    )?.groupId
  return { runtime, open, groupOfFile }
}

describe('a file main opens lands in the group the window shows', () => {
  it('the group the window switched to just now, not the saved one', async () => {
    const host = twoGroupHost()
    host.runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      activeGroupByWorkspace: { [TEST_WORKTREE_ID]: 'g2' }
    })

    await host.open()

    expect(host.groupOfFile()).toBe('g2')
  })

  it("the saved view's group while no window has reported one", async () => {
    const host = twoGroupHost()

    await host.open()

    expect(host.groupOfFile()).toBe('g1')
  })
})

describe('a file main opens lands in the group a paired desktop shows', () => {
  it("the latest desktop's group, then the other's when that one's connection closes", async () => {
    const host = twoGroupHost()
    host.runtime.reportClientView('desktop-a', { [TEST_WORKTREE_ID]: 'g2' })
    host.runtime.reportClientView('desktop-b', { [TEST_WORKTREE_ID]: 'g1' })
    expect(host.runtime.groupForTest(TEST_WORKTREE_ID)).toBe('g1')

    host.runtime.cleanupSubscriptionsForConnection('desktop-b')
    await host.open()

    expect(host.groupOfFile()).toBe('g2')
  })

  it("the saved view's once every reporting desktop has gone", async () => {
    const host = twoGroupHost()
    host.runtime.reportClientView('desktop-a', { [TEST_WORKTREE_ID]: 'g2' })
    host.runtime.reportClientView('desktop-a', { [TEST_WORKTREE_ID]: 'g2' })
    host.runtime.cleanupSubscriptionsForConnection('desktop-a')

    expect(host.runtime.groupForTest(TEST_WORKTREE_ID)).toBe('g1')
  })

  it('the window, when it reported after the desktop', () => {
    const host = twoGroupHost()
    host.runtime.reportClientView('desktop-a', { [TEST_WORKTREE_ID]: 'g1' })
    host.runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      activeGroupByWorkspace: { [TEST_WORKTREE_ID]: 'g2' }
    })

    expect(host.runtime.groupForTest(TEST_WORKTREE_ID)).toBe('g2')
  })
  it("a desktop's refresh after a reconnect leaves the group another desktop switched to", async () => {
    const host = twoGroupHost()
    host.runtime.reportClientView('desktop-a', { [TEST_WORKTREE_ID]: 'g2' })
    host.runtime.reportClientView('desktop-b', { [TEST_WORKTREE_ID]: 'g1' }, true)

    await host.open()

    expect(host.groupOfFile()).toBe('g2')
  })
})
