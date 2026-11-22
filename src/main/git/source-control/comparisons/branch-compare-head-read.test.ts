import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as GitExecFile from '../../command-runner/git-exec-file'
import { GitCommandTimeoutError } from '../../../../shared/git/commands/git-command-timeout'
import { getBranchCompare } from './branch-compare'

const headReadFailure = vi.hoisted(() => {
  const state: { current: (() => Error) | null } = { current: null }
  return state
})

vi.mock('../../command-runner/git-exec-file', async (importOriginal) => {
  const actual = await importOriginal<typeof GitExecFile>()
  return {
    ...actual,
    gitExecFileAsync: (args: string[], options: Parameters<typeof actual.gitExecFileAsync>[1]) => {
      const fail = headReadFailure.current
      if (fail && args[0] === 'rev-parse' && args.at(-1) === 'HEAD') {
        return Promise.reject(fail())
      }
      return actual.gitExecFileAsync(args, options)
    }
  }
})

function gitExitError(code: number, stderr: string): Error {
  return Object.assign(new Error('git failed'), { code, stderr })
}

const tempRoots: string[] = []

afterEach(async () => {
  headReadFailure.current = null
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createUnbornBranchRepo(): Promise<{ repo: string; baseOid: string }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'orca-branch-compare-head-'))
  tempRoots.push(repo)
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim()
  git(['init', '-q', '-b', 'base'])
  git([
    '-c',
    'user.email=t@example.com',
    '-c',
    'user.name=T',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'base'
  ])
  const baseOid = git(['rev-parse', 'HEAD'])
  git(['checkout', '-q', '--orphan', 'feature'])
  return { repo, baseOid }
}

describe('getBranchCompare HEAD read', () => {
  it('reports an unborn branch with a valid base as an empty comparison', async () => {
    const { repo, baseOid } = await createUnbornBranchRepo()

    const { summary, entries } = await getBranchCompare(repo, 'base')

    expect(summary).toMatchObject({ status: 'ready', headOid: null, baseOid, changedFiles: 0 })
    expect(entries).toEqual([])
  })

  it('treats a missing-ref exit 1 as unborn even with login-shell noise on stderr', async () => {
    const { repo, baseOid } = await createUnbornBranchRepo()
    headReadFailure.current = () =>
      gitExitError(
        1,
        'bash: cannot set terminal process group (-1): Inappropriate ioctl for device\n'
      )

    const { summary } = await getBranchCompare(repo, 'base')

    expect(summary).toMatchObject({ status: 'ready', headOid: null, baseOid, changedFiles: 0 })
  })

  it.each([
    ['exit 128', () => gitExitError(128, 'fatal: not a git repository\n'), 'git failed'],
    ['timeout', () => new GitCommandTimeoutError(120_000), 'git timed out.'],
    [
      'EACCES',
      () => Object.assign(new Error('spawn git EACCES'), { code: 'EACCES' }),
      'spawn git EACCES'
    ]
  ])(
    'reports a HEAD read %s as an error, not an empty comparison',
    async (_label, fail, message) => {
      const { repo } = await createUnbornBranchRepo()
      headReadFailure.current = fail

      const { summary } = await getBranchCompare(repo, 'base')

      expect(summary.status).toBe('error')
      expect(summary.errorMessage).toBe(message)
    }
  )
})
