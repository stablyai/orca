import { describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { OrcaRuntimeService } from '../../orca-runtime'

const FOLDER: FolderWorkspace = {
  id: 'notes-1',
  projectGroupId: 'group-1',
  name: 'Notes',
  folderPath: '/fixture/notes',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1,
  createdAt: 1,
  updatedAt: 1
}
const FOLDER_KEY = folderWorkspaceKey(FOLDER.id)
const LIVE_PTY = (worktreeId: string) => ({
  id: 'pty-agent',
  cwd: FOLDER.folderPath,
  title: 'claude',
  worktreeId,
  incarnationId: 'inc-1'
})

function runtimeWithLiveTerminal(worktreeId: string) {
  const applyLayoutCommand = vi.fn(async () => ({
    ok: true as const,
    result: { tabId: 'tab-new', leafId: 'leaf-new', paneKey: 'tab-new:leaf-new' }
  }))
  const store = {
    getRepos: () => [],
    getProjectGroups: () => [{ id: 'group-1', parentPath: '/fixture' }],
    getFolderWorkspaces: () => [FOLDER],
    getSettings: () => ({}),
    getAllWorktreeMeta: () => ({}),
    getWorkspaceSessionHostIds: () => ['local'],
    getWorkspaceSession: () => getDefaultWorkspaceSession(),
    applyLayoutCommand
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the startup pass reads only these store methods.
  const runtime = new OrcaRuntimeService(store as never)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => [LIVE_PTY(worktreeId)],
    listProcessesWithHostScope: async () => ({
      processes: [LIVE_PTY(worktreeId)],
      hostIds: ['local' as const]
    })
  })
  return { runtime, applyLayoutCommand }
}

describe('main’s startup pass over the host census, layout-owner build', () => {
  it('shows a live terminal of a project-group folder workspace in a tab bound to it', async () => {
    const { runtime, applyLayoutCommand } = runtimeWithLiveTerminal(FOLDER_KEY)

    const placement = await runtime.placeUnshownLiveTerminals()

    expect(placement).toEqual({ placed: ['pty-agent'], declined: [] })
    expect(applyLayoutCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'createTerminalTab',
        workspace: FOLDER_KEY,
        adopt: { ptyId: 'pty-agent', incarnationId: 'inc-1' }
      }),
      ['local']
    )
  })

  it('leaves a live terminal of a workspace this host does not know without a tab', async () => {
    const { runtime, applyLayoutCommand } = runtimeWithLiveTerminal('repo-gone::/fixture/gone')

    expect(await runtime.placeUnshownLiveTerminals()).toEqual({ placed: [], declined: [] })
    expect(applyLayoutCommand).not.toHaveBeenCalled()
  })
})
