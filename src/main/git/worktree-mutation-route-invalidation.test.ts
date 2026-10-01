// Worktree add/move/remove/rollback rewrite the `.git` marker the WSL Git route was derived from.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WorktreeModule from './worktree'

const {
  gitExecFileAsyncMock,
  gitExecFileSyncMock,
  translateWslOutputPathsMock,
  listWorktreesMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  gitExecFileSyncMock: vi.fn(),
  translateWslOutputPathsMock: vi.fn((output: string) => output),
  listWorktreesMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: gitExecFileSyncMock,
  translateWslOutputPaths: translateWslOutputPathsMock
}))

vi.mock('./status', () => ({
  resolveGitDir: vi.fn(),
  runWithGitReadCacheInvalidation: <T>(run: () => Promise<T>) => run()
}))

vi.mock('./worktree', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeModule>()),
  resolveWorktreeAddBaseContext: vi.fn(async () => ({ effectiveBase: 'origin/main' })),
  persistWorktreeCreationBase: vi.fn(),
  configurePushAutoSetupRemote: vi.fn()
}))

vi.mock('./worktree-scan-cache', () => ({
  bumpWorktreeScanGeneration: vi.fn(),
  listWorktrees: listWorktreesMock
}))

import { addWorktree } from './worktree-add'
import { moveWorktree } from './worktree-move'
import { removeWorktree } from './worktree-removal'
import {
  resetWslLinkedWorktreeGitRoutingForTests,
  seedWslLinkedWorktreeGitRoutingForTests,
  usesHostGitForWslLinkedWorktree
} from './wsl-linked-worktree-git-routing'

const REPO = String.raw`C:\repo`
const LINKED = String.raw`C:\ws\linked`
const MOVED = String.raw`C:\ws\moved`

function hasCachedHostRoute(path: string): boolean {
  return usesHostGitForWslLinkedWorktree(path, 'Ubuntu', 'win32')
}

beforeEach(() => {
  gitExecFileAsyncMock.mockReset()
  gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
  listWorktreesMock.mockReset()
  listWorktreesMock.mockResolvedValue([])
})

afterEach(() => resetWslLinkedWorktreeGitRoutingForTests())

describe('worktree mutations invalidate the WSL linked-worktree Git route', () => {
  it('drops the target route after `git worktree add`', async () => {
    seedWslLinkedWorktreeGitRoutingForTests(LINKED)

    await addWorktree(REPO, LINKED, 'feature')

    expect(hasCachedHostRoute(LINKED)).toBe(false)
  })

  it('drops the target route even when `git worktree add` fails late', async () => {
    seedWslLinkedWorktreeGitRoutingForTests(LINKED)
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('fatal: could not create leading dirs'))

    await expect(addWorktree(REPO, LINKED, 'feature')).rejects.toThrow('leading dirs')

    expect(hasCachedHostRoute(LINKED)).toBe(false)
  })

  it('drops both routes after `git worktree move`', async () => {
    seedWslLinkedWorktreeGitRoutingForTests(LINKED)
    seedWslLinkedWorktreeGitRoutingForTests(MOVED)

    await moveWorktree(REPO, LINKED, MOVED)

    expect(hasCachedHostRoute(LINKED)).toBe(false)
    expect(hasCachedHostRoute(MOVED)).toBe(false)
  })

  it('drops both routes when `git worktree move` fails', async () => {
    seedWslLinkedWorktreeGitRoutingForTests(LINKED)
    seedWslLinkedWorktreeGitRoutingForTests(MOVED)
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('fatal: destination exists'))

    await expect(moveWorktree(REPO, LINKED, MOVED)).rejects.toThrow('destination exists')

    expect(hasCachedHostRoute(LINKED)).toBe(false)
    expect(hasCachedHostRoute(MOVED)).toBe(false)
  })

  it('drops the route after `git worktree remove`', async () => {
    seedWslLinkedWorktreeGitRoutingForTests(LINKED)

    await removeWorktree(REPO, LINKED, true)

    expect(hasCachedHostRoute(LINKED)).toBe(false)
  })

  it('leaves an unrelated worktree route cached', async () => {
    seedWslLinkedWorktreeGitRoutingForTests(MOVED)

    await removeWorktree(REPO, LINKED, true)

    expect(hasCachedHostRoute(MOVED)).toBe(true)
  })
})
