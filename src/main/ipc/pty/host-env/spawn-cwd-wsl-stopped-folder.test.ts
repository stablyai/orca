import type * as FsPromises from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as BackgroundDistroGateModule from '../../../wsl-background-distro-gate'
import type * as WslMoveScopeGuardModule from '../../../persistence/moving-wsl-projects/wsl-move-scope-guard'
import type { Store } from '../../../persistence'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { wslDistroHoldMessage } from '../../../../shared/wsl-distro-stopped-hold'
import { isWslUserActFor } from '../../../wsl/wsl-user-act-scope'

const mocks = vi.hoisted(() => ({
  stat: vi.fn<(path: string) => Promise<{ isDirectory(): boolean }>>(),
  readWslDistroRunningState: vi.fn<() => Promise<'running' | 'stopped' | 'unverifiable'>>()
}))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  stat: mocks.stat
}))
vi.mock('../../../wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof BackgroundDistroGateModule>()),
  readWslDistroRunningState: mocks.readWslDistroRunningState
}))
vi.mock(
  '../../../persistence/moving-wsl-projects/wsl-move-scope-guard',
  async (importOriginal) => ({
    ...(await importOriginal<typeof WslMoveScopeGuardModule>()),
    isWslMoveCwdFenced: () => false,
    isWslMoveWorkspaceBlocked: () => false
  })
)

import { assertWorkspaceAcceptsNewPty } from './spawn-cwd'
import { getFolderWorkspacePathStatus } from '../../../project-groups/folder-workspace-path-status'

const FOLDER = '\\\\wsl.localhost\\Ubuntu\\home\\me\\notes'
const WORKTREE_ID = folderWorkspaceKey('folder-1')
const originalPlatform = process.platform

function makeStore(twinOrder?: 'remote-first' | 'local-first'): Store {
  const workspace: FolderWorkspace = {
    id: 'folder-1',
    projectGroupId: 'group-1',
    name: 'notes',
    folderPath: FOLDER,
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
  const remote = { ...workspace, connectionId: 'remote', folderPath: '/remote/notes' }
  const folders = twinOrder
    ? twinOrder === 'remote-first'
      ? [remote, workspace]
      : [workspace, remote]
    : [workspace]
  const store = {
    getRepos: () => [],
    getProjectGroups: () => [],
    getFolderWorkspaces: () => folders
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the folder check reads only these three store methods.
  return store as unknown as Store
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  mocks.stat.mockReset()
  mocks.stat.mockImplementation(async () => {
    expect(isWslUserActFor('Ubuntu')).toBe(true)
    return { isDirectory: () => true }
  })
  mocks.readWslDistroRunningState.mockReset()
  mocks.readWslDistroRunningState.mockResolvedValue('stopped')
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
})

describe('a folder workspace on a stopped WSL distro', () => {
  it.each(['remote-first', 'local-first'] as const)(
    'keeps the selected host through the passive WSL check (%s)',
    async (order) => {
      const store = makeStore(order)
      await expect(
        assertWorkspaceAcceptsNewPty(store, WORKTREE_ID, 'session-1', undefined, true, null)
      ).rejects.toThrow(wslDistroHoldMessage('Ubuntu', 'stopped'))
      expect(mocks.stat).not.toHaveBeenCalled()
      mocks.readWslDistroRunningState.mockClear()
      await expect(
        assertWorkspaceAcceptsNewPty(store, WORKTREE_ID, 'session-1', undefined, true, 'remote')
      ).rejects.toThrow('folder_workspace_path_unavailable:/remote/notes')
      expect(mocks.stat).not.toHaveBeenCalled()
      expect(mocks.readWslDistroRunningState).not.toHaveBeenCalled()
    }
  )

  it('reports the folder unavailable to a background status read without touching it', async () => {
    await expect(
      getFolderWorkspacePathStatus(makeStore(), {
        scope: 'folder-workspace',
        folderWorkspaceId: 'folder-1'
      })
    ).resolves.toEqual({ path: FOLDER, exists: false, reason: 'unavailable' })
    expect(mocks.stat).not.toHaveBeenCalled()
  })

  it('holds a passive restore with Start instead of checking the folder', async () => {
    await expect(
      assertWorkspaceAcceptsNewPty(makeStore(), WORKTREE_ID, 'session-1', undefined, true)
    ).rejects.toThrow(wslDistroHoldMessage('Ubuntu', 'stopped'))
    expect(mocks.stat).not.toHaveBeenCalled()
  })

  it('checks the folder as the user act for a spawn the user asked for', async () => {
    await expect(
      assertWorkspaceAcceptsNewPty(makeStore(), WORKTREE_ID, undefined, undefined, false)
    ).resolves.toBeUndefined()
    expect(mocks.stat).toHaveBeenCalledExactlyOnceWith(FOLDER)
  })

  it('lets a passive restore check the folder once the distro runs', async () => {
    mocks.readWslDistroRunningState.mockResolvedValue('running')
    mocks.stat.mockResolvedValue({ isDirectory: () => true })
    await expect(
      assertWorkspaceAcceptsNewPty(makeStore(), WORKTREE_ID, 'session-1', undefined, true)
    ).resolves.toBeUndefined()
    expect(mocks.stat).toHaveBeenCalledExactlyOnceWith(FOLDER)
  })
})
