import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, describe, expect, it } from 'vitest'
import { getEffectiveGitUpstreamStatus } from '../../shared/git-effective-upstream'
import { loadGitHistoryFromExecutor } from '../../shared/git-history'
import { resolveConfiguredGitPushTarget } from '../../shared/git-push-target-resolution'
import { gitPush } from './remote'
import { installRealWorkerThreadChildProcesses } from '../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'

const directories: string[] = []
const branches = [
  { branch: 'ordinary', tag: false },
  { branch: 'heads/release', tag: false },
  { branch: 'release', tag: true },
  { branch: 'heads/release', tag: true }
]

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function createRepo(branch: string, tag: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'orca-current-branch-'))
  directories.push(directory)
  const git = async (args: string[], cwd = directory) => {
    const result = await runProcess({ program: 'git', args, cwd })
    if (result.code !== 0) {
      throw new Error(result.stderr)
    }
    return { stdout: result.stdout }
  }
  await git(['init', '-q'])
  await git(['symbolic-ref', 'HEAD', `refs/heads/${branch}`])
  await git(['config', 'user.name', 'Audit'])
  await git(['config', 'user.email', 'audit@example.test'])
  await git(['config', 'commit.gpgsign', 'false'])
  await git(['config', 'core.hooksPath', ''])
  await git(['commit', '--allow-empty', '-qm', 'base'])
  const base = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  if (tag) {
    await git(['tag', branch])
  }
  await git(['commit', '--allow-empty', '-qm', 'feature'])
  const head = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  const origin = join(directory, 'origin.git')
  const fork = join(directory, 'fork.git')
  for (const [name, path] of [
    ['origin', origin],
    ['fork', fork]
  ] as const) {
    await git(['init', '--bare', '-q', path])
    await git(['remote', 'add', name, path])
  }
  await git(['update-ref', 'refs/remotes/origin/main', base])
  await git(['update-ref', `refs/remotes/origin/${branch}`, head])
  return { directory, git, head, origin, fork }
}

describe.each(branches)('current branch $branch, tag=$tag', ({ branch, tag }) => {
  it('pushes to the configured fork and destination', async () => {
    const { directory, git, head, origin, fork } = await createRepo(branch, tag)
    await git(['config', `branch.${branch}.remote`, 'fork'])
    await git(['config', `branch.${branch}.merge`, 'refs/heads/published'])

    await gitPush(directory)

    expect((await git(['for-each-ref', '--format=%(refname)', 'refs/heads/'], origin)).stdout).toBe(
      ''
    )
    expect((await git(['rev-parse', '--verify', 'refs/heads/published'], fork)).stdout.trim()).toBe(
      head
    )
    expect((await git(['symbolic-ref', 'HEAD'])).stdout.trim()).toBe(`refs/heads/${branch}`)
  })

  it('resolves a published same-name upstream over legacy origin/main tracking', async () => {
    const { git } = await createRepo(branch, tag)
    await git(['config', `branch.${branch}.remote`, 'origin'])
    await git(['config', `branch.${branch}.merge`, 'refs/heads/main'])

    expect(await getEffectiveGitUpstreamStatus(git)).toEqual({
      hasUpstream: true,
      upstreamName: `origin/${branch}`,
      ahead: 0,
      behind: 0
    })
  })

  it('keeps the current history reference exact', async () => {
    const { directory, git, head } = await createRepo(branch, tag)
    const history = await loadGitHistoryFromExecutor(git, directory)

    expect(history.currentRef).toEqual({
      id: `refs/heads/${branch}`,
      name: branch,
      revision: head,
      category: 'branches'
    })
    expect(history.items.some((item) => item.id === head)).toBe(true)
  })
})

it('preserves detached history and does not infer a branch push target', async () => {
  const { directory, git, head } = await createRepo('release', true)
  await git(['config', 'branch.release.remote', 'fork'])
  await git(['config', 'branch.release.merge', 'refs/heads/published'])
  await git(['checkout', '--detach', '-q', head])

  expect(await resolveConfiguredGitPushTarget(git)).toBeNull()
  expect(await getEffectiveGitUpstreamStatus(git)).toEqual({
    hasUpstream: false,
    ahead: 0,
    behind: 0
  })
  const history = await loadGitHistoryFromExecutor(git, directory)
  expect(history.currentRef).toEqual({
    id: head,
    name: head.slice(0, 7),
    revision: head,
    category: 'commits'
  })
})

installRealWorkerThreadChildProcesses()
