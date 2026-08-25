import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, execFileSyncMock, spawnMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
  spawn: spawnMock
}))
vi.mock('../observability/instrumentation', () => ({
  withGitSpan: (_attributes: unknown, run: () => unknown) => run()
}))
vi.mock('../diagnostics/main-thread-churn-probe', () => ({ recordSubprocessSpawn: vi.fn() }))

import { gitExecFileAsync } from './runner'
import {
  resetWslGitReadEnvironmentForTests,
  seedWslGitReadEnvironmentForTests
} from './wsl-git-read-environment'
import { resetWslLinkedWorktreeGitRoutingForTests } from './wsl-linked-worktree-git-routing'

const WSL_CWD = String.raw`\\wsl.localhost\Ubuntu\home\user\repo`
const UBUNTU_ENVIRONMENT = {
  gitPath: '/usr/bin/git',
  home: '/home/user',
  path: '/ubuntu/bin:/usr/bin'
}
const DEBIAN_ENVIRONMENT = {
  gitPath: '/opt/debian/git',
  home: '/home/other',
  path: '/debian/bin:/usr/bin'
}

async function withWin32<T>(run: () => Promise<T>): Promise<T> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  try {
    return await run()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

async function argvFor(
  args: string[],
  options: { cwd: string; wslDistro?: string }
): Promise<string[]> {
  execFileMock.mockClear()
  await gitExecFileAsync(args, options)
  return execFileMock.mock.calls.at(-1)?.[1] as string[]
}

describe('WSL git execution mode', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    resetWslGitReadEnvironmentForTests()
    resetWslLinkedWorktreeGitRoutingForTests()
    execFileMock.mockImplementation((_binary, _args, _options, callback) => {
      callback?.(null, '', '')
      return new EventEmitter()
    })
  })

  // The load-bearing premise of keying capability state off the cwd: the runner
  // executes where the cwd points. Both the distro flag and the guest environment
  // must come from Ubuntu even though the caller named Debian.
  it('runs a read in the cwd distro, with that distro environment, despite a conflicting hint', async () => {
    await withWin32(async () => {
      seedWslGitReadEnvironmentForTests('Ubuntu', UBUNTU_ENVIRONMENT)
      seedWslGitReadEnvironmentForTests('Debian', DEBIAN_ENVIRONMENT)

      const argv = await argvFor(['rev-parse', '--show-toplevel'], {
        cwd: WSL_CWD,
        wslDistro: 'Debian'
      })

      expect(argv.slice(0, 2)).toEqual(['-d', 'Ubuntu'])
      expect(argv).toContain(UBUNTU_ENVIRONMENT.gitPath)
      expect(argv).toContain(`PATH=${UBUNTU_ENVIRONMENT.path}`)
      expect(argv).not.toContain(DEBIAN_ENVIRONMENT.gitPath)
      expect(argv).not.toContain(`PATH=${DEBIAN_ENVIRONMENT.path}`)
      expect(argv.join(' ')).toContain('/home/user/repo')
    })
  })

  // A write can never take the shell-free read route, so the same assertion holds
  // whether or not the environment probe has resolved.
  it('runs a write in the cwd distro despite a conflicting hint', async () => {
    await withWin32(async () => {
      seedWslGitReadEnvironmentForTests('Ubuntu', UBUNTU_ENVIRONMENT)
      seedWslGitReadEnvironmentForTests('Debian', DEBIAN_ENVIRONMENT)

      const argv = await argvFor(['commit', '-m', 'x'], { cwd: WSL_CWD, wslDistro: 'Debian' })

      expect(argv.slice(0, 2)).toEqual(['-d', 'Ubuntu'])
      expect(argv.at(-1)).toContain('/home/user/repo')
    })
  })

  // A read no longer needs the caller to repeat what the cwd already says.
  it('gives a read the same shell-free route with or without the hint', async () => {
    await withWin32(async () => {
      seedWslGitReadEnvironmentForTests('Ubuntu', UBUNTU_ENVIRONMENT)

      const withoutHint = await argvFor(['rev-parse', '--show-toplevel'], { cwd: WSL_CWD })
      const withHint = await argvFor(['rev-parse', '--show-toplevel'], {
        cwd: WSL_CWD,
        wslDistro: 'Ubuntu'
      })

      expect(withoutHint.slice(2, 4)).toEqual(['--exec', '/usr/bin/env'])
      expect(withoutHint).toEqual(withHint)
    })
  })

  /**
   * Characterization, not endorsement: a write still picks its shell from the
   * presence of `wslDistro`, which carries no routing information once the cwd
   * names the distro. Left as-is here because flipping it decides whether every
   * WSL write gets the user's PATH and ssh-agent -- a change that needs its own
   * PR and real-Windows evidence. This pins today's behavior as a parity anchor.
   */
  it('still picks a write shell from the hint rather than the host', async () => {
    await withWin32(async () => {
      seedWslGitReadEnvironmentForTests('Ubuntu', UBUNTU_ENVIRONMENT)

      const withoutHint = await argvFor(['commit', '-m', 'x'], { cwd: WSL_CWD })
      const withHint = await argvFor(['commit', '-m', 'x'], {
        cwd: WSL_CWD,
        wslDistro: 'Ubuntu'
      })

      // No hint: a bare non-login shell -- no ~/.profile, so no user PATH and no
      // ssh-agent, which an authenticated push needs.
      expect(withoutHint.slice(2, 5)).toEqual(['--exec', 'bash', '-c'])
      expect(withoutHint.at(-1)).not.toContain('getent passwd')

      // Same command, same host, one optional field later: the user's login shell.
      expect(withHint.slice(2, 5)).toEqual(['--exec', 'sh', '-lc'])
      expect(withHint.at(-1)).toContain('getent passwd')
    })
  })
})
