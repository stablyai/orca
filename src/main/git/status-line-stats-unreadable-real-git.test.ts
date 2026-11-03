import { chmod, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GIT_STATUS_LINE_STATS_CACHE_MAX_AGE_MS } from '../../shared/git-status-line-stats-cache'
import { getStatus, invalidateGitReadCaches } from './status'

// chmod 000 gives Git the same "cannot hash" failure as a Windows sharing lock.
const canDenyRead = process.platform !== 'win32' && process.getuid?.() !== 0

let root: string
let repo: string

function git(args: string[], cwd = repo): void {
  const result = runProcessSync({ program: 'git', args, cwd })
  expect(result.code, result.stderr).toBe(0)
}

describe.skipIf(!canDenyRead)('line counts with an unreadable file', () => {
  beforeEach(async () => {
    invalidateGitReadCaches()
    root = await mkdtemp(join(tmpdir(), 'orca-status-unreadable-'))
    repo = join(root, 'repo')
    const emptyConfig = join(root, 'empty-git-config')
    await writeFile(emptyConfig, '')
    vi.stubEnv('GIT_CONFIG_GLOBAL', emptyConfig)
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    git(['init', '-q', repo], root)
    git(['config', 'user.name', 'Test'])
    git(['config', 'user.email', 'test@example.invalid'])
    await writeFile(join(repo, 'locked.txt'), 'alpha\n')
    await writeFile(join(repo, 'locked-too.txt'), 'gamma\n')
    await writeFile(join(repo, 'old.txt'), 'one\ntwo\nthree\n')
    await writeFile(join(repo, 'ok.txt'), 'beta\n')
    git(['add', '.'])
    git(['commit', '-qm', 'baseline'])
    await writeFile(join(repo, 'locked.txt'), 'alpha\nchanged\n')
    await writeFile(join(repo, 'locked-too.txt'), 'gamma\nchanged\n')
    await writeFile(join(repo, 'ok.txt'), 'beta\nchanged\n')
    await chmod(join(repo, 'locked.txt'), 0o000)
    await chmod(join(repo, 'locked-too.txt'), 0o000)
  })

  afterEach(async () => {
    await chmod(join(repo, 'locked.txt'), 0o644)
    await chmod(join(repo, 'locked-too.txt'), 0o644)
    invalidateGitReadCaches()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })

  it('counts the other rows and recounts the file once it is readable', async () => {
    const { entries } = await getStatus(repo)

    expect(entries).toEqual([
      { path: 'locked-too.txt', status: 'modified', area: 'unstaged' },
      { path: 'locked.txt', status: 'modified', area: 'unstaged' },
      { path: 'ok.txt', status: 'modified', area: 'unstaged', added: 1, removed: 0 }
    ])

    await chmod(join(repo, 'locked.txt'), 0o644)
    await chmod(join(repo, 'locked-too.txt'), 0o644)
    const pastExclusionExpiry = performance.now() + GIT_STATUS_LINE_STATS_CACHE_MAX_AGE_MS
    vi.spyOn(performance, 'now').mockReturnValue(pastExclusionExpiry)
    invalidateGitReadCaches()

    expect((await getStatus(repo)).entries).toEqual([
      { path: 'locked-too.txt', status: 'modified', area: 'unstaged', added: 1, removed: 0 },
      { path: 'locked.txt', status: 'modified', area: 'unstaged', added: 1, removed: 0 },
      { path: 'ok.txt', status: 'modified', area: 'unstaged', added: 1, removed: 0 }
    ])
  })

  it.each([
    { diffRenames: 'true', renamed: true },
    { diffRenames: 'false', renamed: false }
  ])('keeps the rename policy with diff.renames=$diffRenames', async ({ diffRenames, renamed }) => {
    git(['config', 'diff.renames', diffRenames])
    await rename(join(repo, 'old.txt'), join(repo, 'new.txt'))
    git(['add', '-N', 'new.txt'])

    const { entries } = await getStatus(repo)

    expect(entries).toEqual(
      expect.arrayContaining([
        { path: 'ok.txt', status: 'modified', area: 'unstaged', added: 1, removed: 0 },
        ...(renamed
          ? [
              {
                path: 'new.txt',
                oldPath: 'old.txt',
                status: 'renamed',
                area: 'unstaged',
                added: 0,
                removed: 0
              }
            ]
          : [
              { path: 'new.txt', status: 'added', area: 'unstaged', added: 3, removed: 0 },
              { path: 'old.txt', status: 'deleted', area: 'unstaged', added: 0, removed: 3 }
            ])
      ])
    )
    expect(entries.find((entry) => entry.path === 'locked.txt')?.added).toBeUndefined()
  })
})
