import { execFile } from 'node:child_process'
import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import * as gitExecFile from '../../command-runner/git-exec-file'
import { baseRefExistsOnRemote } from '../../../source-control/hosted-review-creation-git-state'
import {
  getPullRequestRemoteRefState,
  type PullRequestGitExec
} from '../../../text-generation/pull-request-context/pull-request-remote-ref-probes'

// Perf contract (#36156): finding a base branch's remote-tracking ref ran one `git show-ref` per remote.

// The worker-thread spawner's entry is a build output, so Windows unit runs spawn Git directly, as macOS and Linux do.
vi.mock(
  '../../../worker-thread-child-process/worker-thread-child-process',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    canSpawnOnWorkerThread: () => false
  })
)

const run = promisify(execFile)
const REMOTES = 100
const roots: string[] = []

async function git(cwd: string, args: string[]): Promise<string> {
  return (await run('git', args, { cwd })).stdout
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** A repository with `REMOTES` configured remotes; only r57 has fetched `main`. */
async function manyRemotes(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-exact-ref-'))
  roots.push(root)
  await git(root, ['init', '--quiet', '--object-format=sha1'])
  await git(root, [
    '-c',
    'user.name=Orca Test',
    '-c',
    'user.email=orca-test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'base'
  ])
  const remotes = Array.from(
    { length: REMOTES },
    (_, index) => `[remote "r${index}"]\n\turl = https://example.invalid/r${index}.git\n`
  )
  await appendFile(join(root, '.git', 'config'), remotes.join(''))
  await git(root, ['update-ref', 'refs/remotes/r57/main', 'HEAD'])
  return root
}

it('hosted-review base checks probe every remote in one Git call', async () => {
  const repository = await manyRemotes()
  const calls = vi.spyOn(gitExecFile, 'gitExecFileAsync')

  const exists = await baseRefExistsOnRemote('main', repository, 'local')

  expect({ exists, git: calls.mock.calls.map(([args]) => args[0]) }).toEqual({
    exists: true,
    git: ['remote', 'for-each-ref']
  })
})

it('pull-request context resolves a base across every remote in one exact-ref Git call', async () => {
  const repository = await manyRemotes()
  const commands: string[] = []
  const execGit: PullRequestGitExec = (args, options) => {
    commands.push(args[0])
    return gitExecFile.gitExecFileAsync(args, { cwd: repository, maxBuffer: options?.maxBuffer })
  }

  const state = await getPullRequestRemoteRefState(execGit, 'main', 1024 * 1024)

  // The suffix listing runs once because neither origin nor upstream is configured.
  expect({ refs: state.refs, commands }).toEqual({
    refs: ['r57/main'],
    commands: ['remote', 'for-each-ref', 'show-ref']
  })
})
