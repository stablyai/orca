import { runProcess } from '@orca/process-host'
import { mkdtemp, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StatusPorcelainParser } from '../../shared/git-status-porcelain-parser'

async function git(args: string[], cwd: string, env = process.env) {
  const result = await runProcess({ program: 'git', args, cwd, env })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
  return result
}

vi.mock('./runner', () => ({
  gitExecFileAsync: (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) =>
    git(args, options.cwd, options.env),
  gitOptionalLocksDisabledEnv: () => ({ ...process.env, GIT_OPTIONAL_LOCKS: '0' })
}))

import { attachLineStats } from './source-control/status-line-stats'

let repo: string

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'orca-status-renames-'))
  const emptyConfig = join(repo, 'empty-git-config')
  await writeFile(emptyConfig, '')
  vi.stubEnv('GIT_CONFIG_GLOBAL', emptyConfig)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  await git(['init', '-q'], repo)
  await git(['config', 'user.name', 'Test'], repo)
  await git(['config', 'user.email', 'test@example.invalid'], repo)
  await git(['config', 'commit.gpgsign', 'false'], repo)
  await git(['config', 'core.autocrlf', 'false'], repo)
  await writeFile(join(repo, 'old.txt'), 'alpha\nbeta\ngamma\n')
  await git(['add', 'old.txt'], repo)
  await git(['commit', '-qm', 'baseline'], repo)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(repo, { recursive: true, force: true })
})

async function readEntries(complete = true) {
  const { stdout } = await git(['status', '--porcelain=v2', '--untracked-files=no'], repo, {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0'
  })
  const parser = new StatusPorcelainParser()
  parser.update(stdout, 0)
  parser.finish()
  expect(await attachLineStats(repo, parser.entries)).toBe(complete)
  return parser.entries
}

describe.each(['staged', 'unstaged'] as const)('%s rename line counts', (area) => {
  it.each([
    { diffRenames: 'true', statusRenames: undefined, renamed: true },
    { diffRenames: 'false', statusRenames: undefined, renamed: false },
    { diffRenames: 'true', statusRenames: 'false', renamed: false },
    { diffRenames: 'false', statusRenames: 'true', renamed: true }
  ])('matches status with $diffRenames diff / $statusRenames status', async (config) => {
    await git(['config', 'diff.renames', config.diffRenames], repo)
    if (config.statusRenames !== undefined) {
      await git(['config', 'status.renames', config.statusRenames], repo)
    }
    await rename(join(repo, 'old.txt'), join(repo, 'new.txt'))
    await git(
      area === 'staged' ? ['add', '-A', '--', 'old.txt', 'new.txt'] : ['add', '-N', 'new.txt'],
      repo
    )

    const entries = await readEntries()

    expect(entries).toEqual(
      config.renamed
        ? [{ path: 'new.txt', oldPath: 'old.txt', status: 'renamed', area, added: 0, removed: 0 }]
        : [
            { path: 'new.txt', status: 'added', area, added: 3, removed: 0 },
            { path: 'old.txt', status: 'deleted', area, added: 0, removed: 3 }
          ]
    )
  })

  it.each(['', 'extra\n'])('counts a copied file relative to its source (%j)', async (extra) => {
    await git(['config', 'status.renames', 'copies'], repo)
    await writeFile(join(repo, 'new.txt'), `alpha\nbeta\ngamma\n${extra}`)
    await writeFile(join(repo, 'old.txt'), 'alpha\nbeta\ngamma\ndelta\n')
    await git(area === 'staged' ? ['add', 'old.txt', 'new.txt'] : ['add', '-N', 'new.txt'], repo)

    expect(await readEntries()).toEqual([
      {
        path: 'new.txt',
        oldPath: 'old.txt',
        status: 'copied',
        area,
        added: extra ? 1 : 0,
        removed: 0
      },
      { path: 'old.txt', status: 'modified', area, added: 1, removed: 0 }
    ])
  })
})

it.each([false, true])(
  'leaves incompatible copy stats uncached (wrong source: %j)',
  async (wrongSource) => {
    const twin = wrongSource ? 'alpha\nbeta\ngamma\nextra\n' : 'one\ntwo\nthree\n'
    await writeFile(join(repo, 'twin.txt'), twin)
    await git(['add', 'twin.txt'], repo)
    await git(['commit', '-qm', 'unchanged copy candidate'], repo)
    await git(['config', 'status.renames', 'copies'], repo)
    await writeFile(join(repo, 'copy.txt'), wrongSource ? twin : 'alpha\nbeta\ngamma\n')
    await writeFile(join(repo, 'old.txt'), 'alpha\nbeta\ngamma\ndelta\n')
    await writeFile(join(repo, 'fresh.txt'), 'one\ntwo\nthree\n')
    await git(['add', '-N', 'copy.txt', 'fresh.txt'], repo)
    const indexPath = join(repo, '.git', 'index')
    const before = await readFile(indexPath)
    const future = new Date(Date.now() + 10_000)
    await utimes(join(repo, 'twin.txt'), future, future)

    expect(await readEntries(false)).toEqual([
      { path: 'copy.txt', oldPath: 'old.txt', status: 'copied', area: 'unstaged' },
      { path: 'fresh.txt', status: 'added', area: 'unstaged' },
      { path: 'old.txt', status: 'modified', area: 'unstaged' }
    ])
    expect(await readFile(indexPath)).toEqual(before)
  }
)

it('keeps unstaged edits separate from a staged rename', async () => {
  await git(['mv', 'old.txt', 'new.txt'], repo)
  await writeFile(join(repo, 'new.txt'), 'alpha\nbeta\ngamma\ndelta\n')

  expect(await readEntries()).toEqual([
    {
      path: 'new.txt',
      oldPath: 'old.txt',
      status: 'renamed',
      area: 'staged',
      added: 0,
      removed: 0
    },
    {
      path: 'new.txt',
      oldPath: 'old.txt',
      status: 'modified',
      area: 'unstaged',
      added: 1,
      removed: 0
    }
  ])
})
