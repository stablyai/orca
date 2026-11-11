import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getBranchCompare } from './branch-compare'
import { settledBranchChangeListCache } from './branch-change-list-cache'

// Old mtimes put every input past the racy-write margin, so only stamp contents decide reuse.
const aged = new Date('2020-01-01T00:00:00Z')
const savedEnv = {
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME
}
let root = ''

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

async function age(...files: string[]): Promise<void> {
  await Promise.all(files.map((file) => utimes(file, aged, aged)))
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-branch-change-list-')))
  // Isolate from the developer's global config, whose recent edits would make stamps unprovable.
  process.env.GIT_CONFIG_GLOBAL = path.join(root, 'gitconfig')
  process.env.XDG_CONFIG_HOME = path.join(root, 'xdg')
  await writeFile(process.env.GIT_CONFIG_GLOBAL, '')
  await age(process.env.GIT_CONFIG_GLOBAL)
})

afterEach(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = value
    }
  }
  await rm(root, { recursive: true, force: true })
})

describe('branch compare changed-files reuse', () => {
  it('reuses the list until worktree attributes or diff config change its numstat', async () => {
    const repo = path.join(root, 'repo')
    await mkdir(path.join(repo, 'docs'), { recursive: true })
    git(repo, ['init', '-q', '-b', 'base'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    git(repo, ['config', 'user.name', 'Test User'])
    git(repo, ['config', 'commit.gpgSign', 'false'])
    await writeFile(path.join(repo, 'docs', 'notes.txt'), 'a\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'base'])
    git(repo, ['checkout', '-qb', 'feature'])
    await writeFile(path.join(repo, 'docs', 'notes.txt'), 'a\nb\n')
    git(repo, ['commit', '-qam', 'feature'])
    const repoConfig = path.join(repo, '.git', 'config')
    const nestedAttributes = path.join(repo, 'docs', '.gitattributes')
    await age(path.join(repo, '.git', 'index'), repoConfig)

    const counted = [{ path: 'docs/notes.txt', status: 'modified', added: 1, removed: 0 }]
    const binary = [{ path: 'docs/notes.txt', status: 'modified' }]
    expect((await getBranchCompare(repo, 'base')).entries).toEqual(counted)
    const hitsBefore = settledBranchChangeListCache.stats().hits
    expect((await getBranchCompare(repo, 'base')).entries).toEqual(counted)
    expect(settledBranchChangeListCache.stats().hits).toBe(hitsBefore + 1)

    await writeFile(nestedAttributes, '*.txt -diff\n')
    await age(nestedAttributes)
    expect((await getBranchCompare(repo, 'base')).entries).toEqual(binary)

    await writeFile(nestedAttributes, '*.txt diff=prose\n')
    await age(nestedAttributes)
    expect((await getBranchCompare(repo, 'base')).entries).toEqual(counted)

    git(repo, ['config', 'diff.prose.binary', 'true'])
    await age(repoConfig)
    expect((await getBranchCompare(repo, 'base')).entries).toEqual(binary)
  })
})
