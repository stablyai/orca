import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Repo } from '../../shared/repo-types'
import {
  renameWorktreeFolderOnFirstWork,
  type FirstWorkFolderRenameDeps
} from './first-work-folder-rename'

const REPO = { id: 'repo1', path: '/repos/orca', connectionId: null } as unknown as Repo
const SETTINGS = { nestWorkspaces: false, workspaceDir: '/ws' } as unknown as GlobalSettings
const OLD_ID = 'repo1::/ws/cunner'
const FOLDER_WORKSPACE_ID = 'repo1::/ws/cunner::workspace:12345678-1234-1234-1234-123456789abc'

function makeDeps(overrides: Partial<FirstWorkFolderRenameDeps> = {}): FirstWorkFolderRenameDeps {
  return {
    getRepo: vi.fn(() => REPO),
    getSettings: vi.fn(() => SETTINGS),
    migrateWorktreeIdentity: vi.fn(),
    notifyWorktreeRenamed: vi.fn(),
    pathExists: vi.fn(async () => false),
    moveWorktree: vi.fn(async () => {}),
    ...overrides
  }
}

describe('renameWorktreeFolderOnFirstWork', () => {
  const originalPlatform = process.platform
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  })

  it('moves the folder and migrates identity on the happy path', async () => {
    const deps = makeDeps()
    const result = await renameWorktreeFolderOnFirstWork(OLD_ID, 'worktree-creation-spinner', deps)
    expect(result).toBe(true)
    expect(deps.moveWorktree).toHaveBeenCalledWith(
      '/repos/orca',
      '/ws/cunner',
      '/ws/worktree-creation-spinner'
    )
    expect(deps.migrateWorktreeIdentity).toHaveBeenCalledWith(
      OLD_ID,
      'repo1::/ws/worktree-creation-spinner'
    )
    expect(deps.notifyWorktreeRenamed).toHaveBeenCalledWith(
      'repo1',
      OLD_ID,
      'repo1::/ws/worktree-creation-spinner'
    )
    // Main re-keys its stored layout before the window hears of the rename, so the window's
    // re-key and save only mirror it (worktree-identity-rename-main-agreement.test.ts).
    expect(vi.mocked(deps.migrateWorktreeIdentity).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.notifyWorktreeRenamed).mock.invocationCallOrder[0]!
    )
  })

  it('preserves the folder-workspace instance suffix in the migrated identity', async () => {
    const deps = makeDeps()
    const result = await renameWorktreeFolderOnFirstWork(
      FOLDER_WORKSPACE_ID,
      'worktree-creation-spinner',
      deps
    )
    expect(result).toBe(true)
    expect(deps.migrateWorktreeIdentity).toHaveBeenCalledWith(
      FOLDER_WORKSPACE_ID,
      'repo1::/ws/worktree-creation-spinner::workspace:12345678-1234-1234-1234-123456789abc'
    )
    expect(deps.notifyWorktreeRenamed).toHaveBeenCalledWith(
      'repo1',
      FOLDER_WORKSPACE_ID,
      'repo1::/ws/worktree-creation-spinner::workspace:12345678-1234-1234-1234-123456789abc'
    )
  })

  it('skips (no move) when the destination already exists', async () => {
    const deps = makeDeps({ pathExists: vi.fn(async () => true) })
    expect(await renameWorktreeFolderOnFirstWork(OLD_ID, 'taken', deps)).toBe(false)
    expect(deps.moveWorktree).not.toHaveBeenCalled()
    expect(deps.migrateWorktreeIdentity).not.toHaveBeenCalled()
  })

  it('skips remote worktrees without moving', async () => {
    const deps = makeDeps({ getRepo: vi.fn(() => ({ ...REPO, connectionId: 'ssh1' })) })
    expect(await renameWorktreeFolderOnFirstWork(OLD_ID, 'fix-auth', deps)).toBe(false)
    expect(deps.moveWorktree).not.toHaveBeenCalled()
  })

  it('skips runtime-owned worktrees without moving', async () => {
    const deps = makeDeps({
      getRepo: vi.fn(() => ({ ...REPO, executionHostId: 'runtime:gpu-vm' as const }))
    })
    expect(await renameWorktreeFolderOnFirstWork(OLD_ID, 'fix-auth', deps)).toBe(false)
    expect(deps.moveWorktree).not.toHaveBeenCalled()
  })

  it('returns false when the repo is unknown', async () => {
    const deps = makeDeps({ getRepo: vi.fn(() => undefined) })
    expect(await renameWorktreeFolderOnFirstWork(OLD_ID, 'fix-auth', deps)).toBe(false)
    expect(deps.moveWorktree).not.toHaveBeenCalled()
  })
})
