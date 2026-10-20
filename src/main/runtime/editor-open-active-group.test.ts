import './orca-runtime-test-lifecycle.spec'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeStore } from './runtime-store-contract'
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

/** A host whose saved view shows the first of two groups. */
function twoGroupHost() {
  const saved = addWorkspace(emptySession(), TEST_WORKTREE_ID, [
    { id: 'g1', tabs: [{ id: 't1', leaves: [[leaf(1)]] }] },
    { id: 'g2', tabs: [{ id: 't2', leaves: [[leaf(2)]] }] }
  ])
  const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(saved)
  Object.assign(runtimeStore, { getWorkspaceSessionHostIds: () => ['local'] })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The shared fixture supplies RuntimeStore methods; its legacy Mock return type loses callable signatures.
  const runtime = new RuntimeWithEditorOpenGroup(runtimeStore as RuntimeStore)
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
