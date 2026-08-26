import { describe, expect, it } from 'vitest'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import { SSH_FOLDER, makeHarness } from './pty-inventory-scoped-routing-fixtures'

describe('runtime-owned folder mobile authority', () => {
  it('never materializes a pending runtime folder tab through local or SSH PTY providers', async () => {
    const harness = makeHarness()
    const runtimeFolder = {
      ...SSH_FOLDER,
      id: 'folder-runtime-pending',
      name: 'Runtime pending folder',
      folderPath: '/runtime/pending-folder',
      connectionId: null,
      executionHostId: 'runtime:environment-1'
    }
    harness.folderWorkspaces.push(runtimeFolder)
    const worktreeId = folderWorkspaceKey(runtimeFolder.id)
    const ptyId = 'runtime-pending-pty'
    harness.session.tabsByWorktree[worktreeId] = [
      {
        id: 'runtime-pending-tab',
        ptyId,
        worktreeId,
        title: 'Runtime pending',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
    ]

    const listed = await harness.runtime.listMobileSessionTabs(`id:${worktreeId}`)
    expect(listed.tabs.some((tab) => tab.type === 'terminal' && tab.ptyId === ptyId)).toBe(true)
    await expect(
      harness.runtime.activateMobileSessionTab(`id:${worktreeId}`, 'runtime-pending-tab')
    ).rejects.toThrow('terminal_unavailable')

    expect(harness.spawn).not.toHaveBeenCalled()
    expect(harness.listProcesses).not.toHaveBeenCalled()
    expect(harness.listProcessesWithHostScope).not.toHaveBeenCalled()
    expect(harness.providers.local).not.toHaveBeenCalled()
    expect(harness.providers['box-a']).not.toHaveBeenCalled()
    expect(harness.providers['box-b']).not.toHaveBeenCalled()
    expect(harness.providers['box-c']).not.toHaveBeenCalled()
    expect(harness.internals.mobileSessionTabsByWorktree.has(worktreeId)).toBe(true)
  })
})
