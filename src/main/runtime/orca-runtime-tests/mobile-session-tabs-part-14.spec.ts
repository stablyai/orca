import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import {
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeRuntimeStoreWithWorkspaceSession
} from '../orca-runtime-test-fixtures.spec'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

const README = `${TEST_WORKTREE_PATH}/README.md`

/** The editor a converted SSH host's migration writes into the managed server's session. */
function sessionWithMigratedEditor(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    openFilesByWorktree: {
      [TEST_WORKTREE_ID]: [
        {
          filePath: README,
          relativePath: 'README.md',
          worktreeId: TEST_WORKTREE_ID,
          language: 'markdown',
          runtimeEnvironmentId: null
        }
      ]
    },
    unifiedTabs: {
      [TEST_WORKTREE_ID]: [
        {
          id: 'tab-readme',
          entityId: README,
          groupId: 'group-1',
          worktreeId: TEST_WORKTREE_ID,
          contentType: 'editor',
          label: 'README.md',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    tabGroups: {
      [TEST_WORKTREE_ID]: [
        {
          id: 'group-1',
          worktreeId: TEST_WORKTREE_ID,
          activeTabId: 'tab-readme',
          tabOrder: ['tab-readme']
        }
      ]
    },
    activeTabTypeByWorktree: { [TEST_WORKTREE_ID]: 'editor' },
    activeFileIdByWorktree: { [TEST_WORKTREE_ID]: README }
  }
}

function headlessRuntime(session: WorkspaceSessionState) {
  const harness = makeRuntimeStoreWithWorkspaceSession(session)
  const runtime = new OrcaRuntimeService(harness.runtimeStore)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: vi.fn(async () => [])
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  return { runtime, getSession: harness.getSession }
}

describe('editor tabs a headless host persisted', () => {
  it('lists them, so a paired client can mirror a migrated editor', async () => {
    const { runtime } = headlessRuntime(sessionWithMigratedEditor())

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(listed.tabs).toEqual([
      expect.objectContaining({
        type: 'markdown',
        id: 'tab-readme',
        filePath: README,
        relativePath: 'README.md',
        isActive: true
      })
    ])
    expect(listed.activeTabId).toBe('tab-readme')
  })

  it('closes one by retiring it from the host session', async () => {
    const { runtime, getSession } = headlessRuntime(sessionWithMigratedEditor())
    await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'tab-readme')

    expect(getSession().openFilesByWorktree?.[TEST_WORKTREE_ID]).toEqual([])
    expect(getSession().unifiedTabs?.[TEST_WORKTREE_ID]).toEqual([])
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])
  })

  it('keeps an unsaved draft unless the close is forced', async () => {
    const session = sessionWithMigratedEditor()
    const [file] = session.openFilesByWorktree?.[TEST_WORKTREE_ID] ?? []
    session.openFilesByWorktree = { [TEST_WORKTREE_ID]: [{ ...file, dirtyDraftContent: 'draft' }] }
    const { runtime, getSession } = headlessRuntime(session)
    await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    await expect(
      runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'tab-readme')
    ).rejects.toThrow('editor_tab_has_unsaved_draft')
    expect(getSession().openFilesByWorktree?.[TEST_WORKTREE_ID]?.[0]?.dirtyDraftContent).toBe(
      'draft'
    )

    await runtime.closeMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'tab-readme', { force: true })
    expect(getSession().openFilesByWorktree?.[TEST_WORKTREE_ID]).toEqual([])
  })
})
