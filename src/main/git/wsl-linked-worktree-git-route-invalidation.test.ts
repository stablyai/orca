// Route state dropped when a worktree mutation rewrites the `.git` marker it was derived from.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  invalidateWslLinkedWorktreeGitRouting,
  prepareWslLinkedWorktreeGitRouting,
  resetWslLinkedWorktreeGitRoutingForTests,
  type WslLinkedWorktreeRoutingFileSystem
} from './wsl-linked-worktree-git-routing'

afterEach(() => resetWslLinkedWorktreeGitRoutingForTests())

const CWD = String.raw`C:\repo`
const fileMarker = { isDirectory: () => false, isFile: () => true }
const directoryMarker = { isDirectory: () => true, isFile: () => false }
const hostGitdir = 'gitdir: C:/main/.git/worktrees/linked\n'

function prepare(fileSystem: WslLinkedWorktreeRoutingFileSystem): Promise<boolean> {
  return prepareWslLinkedWorktreeGitRouting(CWD, 'Ubuntu', { platform: 'win32', fileSystem })
}

describe('invalidateWslLinkedWorktreeGitRouting', () => {
  it('re-probes a settled route after the worktree marker is rewritten', async () => {
    const fileSystem: WslLinkedWorktreeRoutingFileSystem = {
      stat: vi
        .fn<WslLinkedWorktreeRoutingFileSystem['stat']>()
        .mockResolvedValueOnce(directoryMarker)
        .mockResolvedValueOnce(fileMarker),
      readFile: vi.fn(async () => hostGitdir)
    }

    await expect(prepare(fileSystem)).resolves.toBe(false)
    invalidateWslLinkedWorktreeGitRouting(CWD)

    await expect(prepare(fileSystem)).resolves.toBe(true)
    expect(fileSystem.stat).toHaveBeenCalledTimes(2)
  })

  it('clears the retry backoff so a marker that just appeared is probed immediately', async () => {
    const currentTime = 1_000
    let markerExists = false
    const fileSystem: WslLinkedWorktreeRoutingFileSystem = {
      stat: vi.fn(async () => {
        if (!markerExists) {
          throw Object.assign(new Error('device unavailable'), { code: 'EIO' })
        }
        return fileMarker
      }),
      readFile: vi.fn(async () => hostGitdir)
    }
    const probe = (): Promise<boolean> =>
      prepareWslLinkedWorktreeGitRouting(CWD, 'Ubuntu', {
        platform: 'win32',
        fileSystem,
        now: () => currentTime
      })

    // The second miss enters the exponential retry window, so the third never probes.
    await expect(probe()).resolves.toBe(false)
    await expect(probe()).resolves.toBe(false)
    await expect(probe()).resolves.toBe(false)
    expect(fileSystem.stat).toHaveBeenCalledTimes(2)

    markerExists = true
    invalidateWslLinkedWorktreeGitRouting(CWD)
    await expect(probe()).resolves.toBe(true)
    expect(fileSystem.stat).toHaveBeenCalledTimes(3)
  })

  it('drops routes cached for paths inside the mutated worktree', async () => {
    const submodule = String.raw`C:\repo\sub`
    const sibling = String.raw`C:\repo-other`
    const fileSystem: WslLinkedWorktreeRoutingFileSystem = {
      stat: vi.fn(async () => fileMarker),
      readFile: vi.fn(async () => hostGitdir)
    }
    const probe = (cwd: string): Promise<boolean> =>
      prepareWslLinkedWorktreeGitRouting(cwd, 'Ubuntu', { platform: 'win32', fileSystem })

    await expect(probe(submodule)).resolves.toBe(true)
    await expect(probe(sibling)).resolves.toBe(true)
    invalidateWslLinkedWorktreeGitRouting(CWD)

    // Prefix match must not reach `C:\repo-other`, which shares the string prefix.
    await expect(probe(submodule)).resolves.toBe(true)
    await expect(probe(sibling)).resolves.toBe(true)
    expect(fileSystem.stat).toHaveBeenCalledTimes(3)
  })

  it('leaves a probe that is already in flight alone', async () => {
    // Scope control: invalidation must not retire in-flight probes. Doing so leaves
    // callers waiting on them with no cached route, which `resolveGitCommand` reads
    // as "route through wsl.exe git" — the misroute this module exists to prevent.
    let releaseMarker: ((marker: typeof fileMarker) => void) | undefined
    const inFlight = new Promise<typeof fileMarker>((resolve) => {
      releaseMarker = resolve
    })
    const fileSystem: WslLinkedWorktreeRoutingFileSystem = {
      stat: vi.fn<WslLinkedWorktreeRoutingFileSystem['stat']>().mockReturnValueOnce(inFlight),
      readFile: vi.fn(async () => hostGitdir)
    }

    const first = prepare(fileSystem)
    invalidateWslLinkedWorktreeGitRouting(CWD)
    const joined = prepare(fileSystem)
    releaseMarker?.(fileMarker)

    await expect(first).resolves.toBe(true)
    await expect(joined).resolves.toBe(true)
    expect(fileSystem.stat).toHaveBeenCalledTimes(1)
  })
})
