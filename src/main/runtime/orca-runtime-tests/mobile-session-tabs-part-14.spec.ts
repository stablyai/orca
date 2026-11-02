import { withDurableRuntimeStore } from '../runtime-durable-store-fixture'
import type { PtyControllerInventory } from '../runtime-pty-controller-contract'
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

class MobileSessionCycleRuntime extends OrcaRuntimeService {
  refreshInventory(target: string | null = null) {
    return this.refreshMobileSessionPtyInventory(target)
  }

  override performMobileSessionPtyRecordsRefresh(target: string | null) {
    return super.performMobileSessionPtyRecordsRefresh(target)
  }

  get pendingRefresh() {
    return this.pendingMobileSessionPtyAggregateInventoryRefresh
  }

  set pendingRefresh(value: Promise<PtyControllerInventory | null> | null) {
    this.pendingMobileSessionPtyAggregateInventoryRefresh = value
  }

  closeHostTab() {
    return this.closeTerminalSurface(
      TEST_WORKTREE_ID,
      { kind: 'tab', tabId: 'mobile-cycle-closed-tab' },
      { allowMissing: true, closedByLayoutOwner: true }
    )
  }
}

function mobileCycleRuntime() {
  const harness = makeRuntimeStoreWithWorkspaceSession(getDefaultWorkspaceSession())
  const runtimeStore = withDurableRuntimeStore(
    Object.assign(harness.runtimeStore, { flushOrThrow: () => {} })
  )
  return {
    runtime: new MobileSessionCycleRuntime(runtimeStore),
    harness: { ...harness, runtimeStore }
  }
}

describe('mobile session cycle reentry', () => {
  it('shares aggregate work but leaves a replacement pending promise alone', async () => {
    const { runtime } = mobileCycleRuntime()
    const gate = Promise.withResolvers<PtyControllerInventory | null>()
    const perform = vi
      .spyOn(runtime, 'performMobileSessionPtyRecordsRefresh')
      .mockReturnValue(gate.promise)
    const first = runtime.refreshInventory()
    const stored = runtime.pendingRefresh
    const second = runtime.refreshInventory()
    expect(perform).toHaveBeenCalledExactlyOnceWith(null)
    expect(runtime.pendingRefresh).toBe(stored)
    const replacement = Promise.resolve(null)
    runtime.pendingRefresh = replacement
    gate.resolve(null)
    await expect(first).resolves.toBeNull()
    await expect(second).resolves.toBeNull()
    expect(runtime.pendingRefresh).toBe(replacement)
  })

  it('lets a targeted refresh finish while an aggregate refresh waits', async () => {
    const { runtime } = mobileCycleRuntime()
    const gate = Promise.withResolvers<PtyControllerInventory | null>()
    const perform = vi
      .spyOn(runtime, 'performMobileSessionPtyRecordsRefresh')
      .mockReturnValueOnce(gate.promise)
      .mockResolvedValue(null)
    const aggregate = runtime.refreshInventory()
    await expect(runtime.refreshInventory(TEST_WORKTREE_ID)).resolves.toBeNull()
    expect(perform.mock.calls).toEqual([[null], [TEST_WORKTREE_ID]])
    gate.resolve(null)
    await expect(aggregate).resolves.toBeNull()
    expect(runtime.pendingRefresh).toBeNull()
  })

  it.each(['getWorkspaceSession', 'setWorkspaceSession', 'runDurableMutation'] as const)(
    'refuses a close when the store lacks %s before the guard',
    async (method) => {
      const { runtime, harness } = mobileCycleRuntime()
      Object.defineProperty(harness.runtimeStore, method, { configurable: true, value: undefined })
      await expect(runtime.closeHostTab()).rejects.toThrow('workspace_session_unavailable')
    }
  )

  it.each(['getWorkspaceSession', 'setWorkspaceSession'] as const)(
    'keeps a later missing %s on the original caught failure path',
    async (method) => {
      const { runtime, harness } = mobileCycleRuntime()
      const runDurableMutation = harness.runtimeStore.runDurableMutation
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      error.mockClear()
      try {
        vi.spyOn(harness.runtimeStore, 'runDurableMutation').mockImplementation((mutate) => {
          Object.defineProperty(harness.runtimeStore, method, {
            configurable: true,
            value: undefined
          })
          return runDurableMutation(mutate)
        })
        await expect(runtime.closeHostTab()).resolves.toEqual([])
        expect(error).toHaveBeenCalledExactlyOnceWith(
          '[runtime] failed to persist terminal close:',
          expect.any(TypeError)
        )
      } finally {
        error.mockRestore()
      }
    }
  )
})
