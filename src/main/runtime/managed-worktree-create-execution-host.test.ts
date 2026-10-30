// #11163: executionHostId-only SSH repos must never run local git worktree add on remote paths.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
}))

const createRuntimeFolderWorktreeMock = vi.hoisted(() => vi.fn())
vi.mock('./runtime-folder-worktree-create', () => ({
  createRuntimeFolderWorktree: createRuntimeFolderWorktreeMock
}))

const createRuntimeLocalManagedWorktreeMock = vi.hoisted(() => vi.fn())
vi.mock('./runtime-local-worktree-create', () => ({
  createRuntimeLocalManagedWorktree: createRuntimeLocalManagedWorktreeMock
}))

import { OrcaRuntimeService } from './orca-runtime'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'

const TARGET_ID = 'remote-1'
const REMOTE_PATH = '/srv/app'

type RuntimeInternals = {
  resolveRepoSelector: (selector: string) => Promise<unknown>
  resolveLineageForWorktreeCreate: (input: unknown) => Promise<unknown>
  recordCreatedWorktreeLineage: (worktree: unknown, resolution: unknown) => unknown
}

function makeRuntime(repo: Record<string, unknown>): OrcaRuntimeService {
  const store = {
    getSettings: () => ({ disabledTuiAgents: [], workspaceDir: '/tmp/workspaces' }),
    getProjectHostSetups: () => []
  }
  const runtime = new OrcaRuntimeService(store as never)
  const internals = runtime as unknown as RuntimeInternals
  vi.spyOn(internals, 'resolveRepoSelector').mockResolvedValue(repo)
  vi.spyOn(internals, 'resolveLineageForWorktreeCreate').mockResolvedValue(null)
  vi.spyOn(internals, 'recordCreatedWorktreeLineage').mockReturnValue({
    lineage: null,
    workspaceLineage: null,
    warnings: []
  })
  return runtime
}

describe('createManagedWorktree execution-host routing', () => {
  beforeEach(() => {
    createRuntimeFolderWorktreeMock.mockReset()
    createRuntimeFolderWorktreeMock.mockResolvedValue({ worktree: { id: 'folder-1' } })
    createRuntimeLocalManagedWorktreeMock.mockReset()
    createRuntimeLocalManagedWorktreeMock.mockRejectedValue(
      new Error('local_worktree_create_ran_for_remote_repo')
    )
  })

  it.each([
    ['a repo stamped executionHostId only', { executionHostId: `ssh:${TARGET_ID}` }],
    ['a legacy connectionId-only repo', { connectionId: TARGET_ID }]
  ])('refuses %s instead of creating locally', async (_name, host) => {
    const runtime = makeRuntime({ id: 'repo-remote', path: REMOTE_PATH, kind: 'git', ...host })

    await expect(
      runtime.createManagedWorktree({ repoSelector: 'repo-remote', name: 'feature' })
    ).rejects.toThrow(SshHostNotServedError)

    expect(createRuntimeLocalManagedWorktreeMock).not.toHaveBeenCalled()
  })
})
