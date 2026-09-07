// Why: the batched `cat-file --batch-check` conflict probe decides from stdout, so a
// WSL login-shell fallback that prints the distro banner onto that stream desynchronizes
// the one-line-per-ref contract. Every batch then came back undecided and fell through to
// one `show-ref` subprocess per remote -- the cost the batch exists to remove. These tests
// pin the fence request and the resulting subprocess count at 58 remotes.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))

vi.mock('./runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))

import { getBranchConflictKind } from './repo-branch-conflict'

const REMOTES = Array.from({ length: 58 }, (_, index) => `r${index}`)
const BRANCH = 'user/feature'
const WSL_BANNER =
  'Welcome to Ubuntu 24.04.1 LTS (GNU/Linux 5.15.167.4-microsoft-standard-WSL2 x86_64)\n' +
  'To run a command as administrator (user "root"), use "sudo <command>".\n'

type GitExecOptions = { stdin?: string; captureWslLoginShellOutput?: boolean }

/**
 * Stand-in for a WSL-routed runner: the login shell prepends its banner to stdout unless
 * the caller asked for the fenced form, which slices the payload back out.
 */
function installLoginShellRunner(): { argv: string[][] } {
  const argv: string[][] = []
  gitExecFileAsyncMock.mockImplementation(async (args: string[], options: GitExecOptions = {}) => {
    argv.push(args)
    if (args[0] === 'rev-parse') {
      throw new Error('local branch is absent')
    }
    if (args[0] === 'remote') {
      return { stdout: `${WSL_BANNER}${REMOTES.join('\n')}\n`, stderr: '' }
    }
    if (args[0] === 'show-ref') {
      throw Object.assign(new Error('missing ref'), { code: 1, stderr: '' })
    }
    if (args[0] === 'cat-file') {
      const payload = `${(options.stdin ?? '')
        .split('\n')
        .filter(Boolean)
        .map((ref) => `${ref} missing`)
        .join('\n')}\n`
      return {
        stdout: options.captureWslLoginShellOutput ? payload : `${WSL_BANNER}${payload}`,
        stderr: ''
      }
    }
    throw new Error(`unexpected git command: ${args.join(' ')}`)
  })
  return { argv }
}

function countSubcommand(argv: readonly string[][], subcommand: string): number {
  return argv.filter((args) => args[0] === subcommand).length
}

describe('getBranchConflictKind batched remote probe', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
  })

  it('asks the WSL login shell to fence the batch payload it parses', async () => {
    installLoginShellRunner()

    await getBranchConflictKind('/repo', BRANCH)

    const batchCall = gitExecFileAsyncMock.mock.calls.find(([args]) => args[0] === 'cat-file')
    expect(batchCall?.[1]).toMatchObject({ captureWslLoginShellOutput: true })
  })

  it('answers from one batched subprocess instead of one show-ref per remote', async () => {
    const { argv } = installLoginShellRunner()

    await expect(getBranchConflictKind('/repo', BRANCH)).resolves.toBeNull()

    expect(countSubcommand(argv, 'cat-file')).toBe(1)
    expect(countSubcommand(argv, 'show-ref')).toBe(0)
  })

  it('still falls back to per-ref probes when the batch itself fails', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse') {
        throw new Error('local branch is absent')
      }
      if (args[0] === 'remote') {
        return { stdout: `${REMOTES.join('\n')}\n`, stderr: '' }
      }
      if (args[0] === 'cat-file') {
        throw new Error('cat-file is unavailable on this host')
      }
      if (args[0] === 'show-ref') {
        return { stdout: '', stderr: '' }
      }
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })

    await expect(getBranchConflictKind('/repo', BRANCH)).resolves.toBe('remote')
  })
})
