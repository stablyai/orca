import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTree } from '../../../shared/file-write/windows-transient-lock-removal'
import { gitPush } from './remote'
import { getCurrentBranchAndHead } from '../../source-control/hosted-review-creation-git-state'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host/execution-host'
import { installRealWorkerThreadChildProcesses } from '../../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'

let directory: string | null = null

beforeEach(() => {
  // Push is network-classed, so every gitPush first probes core.sshCommand with a 2.5s
  // budget that flakes under parallel-test spawn load. Local-path remotes never invoke
  // SSH, so short-circuiting that probe is behavior-preserving here.
  vi.stubEnv('GIT_SSH_COMMAND', 'ssh')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  if (directory) {
    // Bun ignores rm maxRetries; removeTree retries the whole pass itself.
    await removeTree(directory)
    directory = null
  }
})

async function createBranchSharingTagName() {
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
  return { repo, git }
}

// Cold node:child_process spawns inside a Bun worker thread cost seconds each; this first test pays for all of them.
it('reads the branch for Create PR when a tag shares the branch name', async () => {
  const { repo, git } = await createBranchSharingTagName()

  expect(await getCurrentBranchAndHead(repo, LOCAL_EXECUTION_HOST_ID)).toEqual({
    branch: 'release',
    headOid: await git(['rev-parse', 'HEAD'])
  })
}, 90_000)

it('pushes to the configured branch target when a tag shares the branch name', async () => {
  const { repo, git } = await createBranchSharingTagName()
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
