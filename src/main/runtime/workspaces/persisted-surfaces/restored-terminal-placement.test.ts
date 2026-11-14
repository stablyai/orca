import { describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { OrcaRuntimeService } from '../../orca-runtime'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

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
const PLACED_LEAF = '33333333-3333-4333-8333-333333333333'

function runtimeWithCwdOnlyTerminal() {
  // The host reports no workspace for this terminal, so only its cwd places it (#36716).
  const live = [{ id: 'pty-agent', cwd: FOLDER.folderPath, title: 'claude' }]
  const store = {
    getRepos: () => [],
    getProjectGroups: () => [{ id: 'group-1', parentPath: '/fixture' }],
    getFolderWorkspaces: () => [FOLDER],
    getFolderWorkspace: (id: string) => (id === FOLDER.id ? FOLDER : undefined),
    getSettings: () => ({}),
    getAllWorktreeMeta: () => ({}),
    getWorkspaceSessionHostIds: () => ['local'],
    getWorkspaceSession: () => getDefaultWorkspaceSession(),
    applyLayoutCommand: vi.fn(async () => ({
      ok: true as const,
      result: { tabId: 'tab-new', leafId: PLACED_LEAF, paneKey: `tab-new:${PLACED_LEAF}` }
    }))
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the startup pass reads only these store methods.
  const runtime = new OrcaRuntimeService(store as never)
  const stopAndWait = vi.fn(async () => true)
  runtime.setPtyController({
    stopAndWait,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => [...live],
    listProcessesWithHostScope: async () => ({
      processes: [...live],
      hostIds: ['local' as const]
    })
  })
  return { runtime, stopAndWait }
}

describe('startup placement of a cwd-filed live terminal', () => {
  it('stops the terminal with its workspace once a pane binds it', async () => {
    const { runtime, stopAndWait } = runtimeWithCwdOnlyTerminal()

    expect(await runtime.placeUnshownLiveTerminals()).toEqual({
      placed: ['pty-agent'],
      declined: []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    await runtime.stopTerminalsForWorktree(`id:${FOLDER_KEY}`)

    expect(stopAndWait).toHaveBeenCalledWith('pty-agent')
  })
})
