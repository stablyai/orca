import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, expect, it } from 'vitest'
import { gitPush } from './remote'
import { installRealWorkerThreadChildProcesses } from '../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'

let directory: string | null = null

afterEach(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true })
    directory = null
  }
})

it('pushes to the configured branch target when a tag shares the branch name', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'orca-current-branch-'))
  directory = repo
  const git = async (args: string[], cwd = repo) => {
    const result = await runProcess({ program: 'git', args, cwd })
    if (result.code !== 0) {
      throw new Error(result.stderr)
    }
    return result.stdout.trim()
  }
  await git(['init', '-q'])
  await git(['symbolic-ref', 'HEAD', 'refs/heads/release'])
  await git(['config', 'user.name', 'Audit'])
  await git(['config', 'user.email', 'audit@example.test'])
  await git(['config', 'commit.gpgsign', 'false'])
  await git(['config', 'core.hooksPath', ''])
  await git(['commit', '--allow-empty', '-qm', 'base'])
  await git(['tag', 'release'])
  await git(['commit', '--allow-empty', '-qm', 'feature'])
  const head = await git(['rev-parse', 'HEAD'])
  const origin = join(repo, 'origin.git')
  const fork = join(repo, 'fork.git')
  await git(['init', '--bare', '-q', origin])
  await git(['init', '--bare', '-q', fork])
  await git(['remote', 'add', 'origin', origin])
  await git(['remote', 'add', 'fork', fork])
  await git(['config', 'branch.release.remote', 'fork'])
  await git(['config', 'branch.release.merge', 'refs/heads/published'])

  await gitPush(repo)

  expect(await git(['for-each-ref', '--format=%(refname)', 'refs/heads/'], origin)).toBe('')
  expect(await git(['rev-parse', '--verify', 'refs/heads/published'], fork)).toBe(head)
})

installRealWorkerThreadChildProcesses()
