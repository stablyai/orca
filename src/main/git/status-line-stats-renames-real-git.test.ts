import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getStatus, invalidateGitReadCaches } from './status'

let root: string
let repo: string

function git(args: string[], cwd = repo): void {
  const result = runProcessSync({ program: 'git', args, cwd })
  expect(result.code, result.stderr).toBe(0)
}

beforeEach(async () => {
  invalidateGitReadCaches()
  root = await mkdtemp(join(tmpdir(), 'orca-status-renames-'))
  repo = join(root, 'repo')
  const emptyConfig = join(root, 'empty-git-config')
  await writeFile(emptyConfig, '')
  vi.stubEnv('GIT_CONFIG_GLOBAL', emptyConfig)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  git(['init', '-q', repo], root)
  git(['config', 'user.name', 'Test'])
  git(['config', 'user.email', 'test@example.invalid'])
  await writeFile(join(repo, 'old.txt'), 'alpha\nbeta\ngamma\n')
  git(['add', 'old.txt'])
  git(['commit', '-qm', 'baseline'])
})

afterEach(async () => {
  invalidateGitReadCaches()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

describe.each(['staged', 'unstaged'] as const)('%s rename line counts', (area) => {
  it.each([
    { diffRenames: 'true', statusRenames: undefined, renamed: true },
    { diffRenames: 'false', statusRenames: undefined, renamed: false },
    { diffRenames: 'true', statusRenames: 'false', renamed: false },
    { diffRenames: 'false', statusRenames: 'true', renamed: true }
  ])('matches status with $diffRenames diff / $statusRenames status', async (config) => {
    git(['config', 'diff.renames', config.diffRenames])
    if (config.statusRenames !== undefined) {
      git(['config', 'status.renames', config.statusRenames])
    }
    await rename(join(repo, 'old.txt'), join(repo, 'new.txt'))
    git(area === 'staged' ? ['add', '-A', '--', 'old.txt', 'new.txt'] : ['add', '-N', 'new.txt'])

    const { entries } = await getStatus(repo)

    expect(entries).toEqual(
      config.renamed
        ? [{ path: 'new.txt', oldPath: 'old.txt', status: 'renamed', area, added: 0, removed: 0 }]
        : [
            { path: 'new.txt', status: 'added', area, added: 3, removed: 0 },
            { path: 'old.txt', status: 'deleted', area, added: 0, removed: 3 }
          ]
    )
  })
})
