import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings, Repo } from '../../shared/types'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  renameWorktreeFolderOnFirstWork,
  type FirstWorkFolderRenameDeps
} from './first-work-folder-rename'

const REPO = { id: 'repo1', path: '/repos/orca', connectionId: null } as unknown as Repo
const SETTINGS = { nestWorkspaces: false, workspaceDir: '/ws' } as unknown as GlobalSettings
const OLD_ID = 'repo1::/ws/cunner'

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

  // #5535 regression: the move must not drop the running session. Wiring the real
  // runtime notify proves the orchestration -> runtime re-point seam: a live PTY
  // record stays bound to the worktree (under the NEW id) across the folder move,
  // instead of being orphaned to the gone old id and replaced by a fresh terminal.
  it('keeps a live PTY bound across the move by re-pointing it to the new id', async () => {
    const runtime = new OrcaRuntimeService()
    const internals = runtime as unknown as {
      recordPtyWorktree: (ptyId: string, worktreeId: string) => { worktreeId: string }
      ptysById: Map<string, { worktreeId: string }>
    }
    const ptyId = `${OLD_ID}@@aaaa`
    internals.recordPtyWorktree(ptyId, OLD_ID)

    const deps = makeDeps({
      notifyWorktreeRenamed: (repoId, oldId, newId) =>
        runtime.notifyWorktreeFolderRenamed(repoId, oldId, newId)
    })

    const result = await renameWorktreeFolderOnFirstWork(OLD_ID, 'work-derived', deps)

    expect(result).toBe(true)
    expect(internals.ptysById.get(ptyId)?.worktreeId).toBe('repo1::/ws/work-derived')
  })
})
