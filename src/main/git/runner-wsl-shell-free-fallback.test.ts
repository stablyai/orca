import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
import { _resetGitAdmissionForTests } from './command-runner/git-subprocess-admission'
import {
  disableWslGitReadEnvironment,
  getWslGitReadEnvironment,
  peekWslGitReadEnvironment,
  resetWslGitReadEnvironmentForTests
} from './wsl-git-read-environment'
import { resetWslLinkedWorktreeGitRoutingForTests } from './wsl-linked-worktree-git-routing'

const DISTRO = 'Ubuntu'
const LOGIN_ENVIRONMENT = {
  gitPath: '/home/user/bin/git',
  home: '/home/user',
  path: '/home/user/bin:/usr/bin:/bin'
}
const LOGIN_ENVIRONMENT_FIELDS = `${LOGIN_ENVIRONMENT.path}\0${LOGIN_ENVIRONMENT.gitPath}\0${LOGIN_ENVIRONMENT.home}`

/** Stand in for the guest shell: rc chatter first, then the payload inside the command's own fence. */
function fencedProbeStdout(command: unknown, payload: string): string {
  const nonce = /__ORCA_WSL_CAPTURE_BEGIN_ ([^_]+)__/.exec(String(command))?.[1] ?? ''
  return `profile banner\n__ORCA_WSL_CAPTURE_BEGIN_${nonce}__${payload}__ORCA_WSL_CAPTURE_END_${nonce}__`
}

type MockChild = EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  pid: number
  kill: ReturnType<typeof vi.fn>
}

function createMockChild(): MockChild {
  const child = new EventEmitter() as MockChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.pid = 1234
  child.kill = vi.fn()
  return child
}

async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return await run()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

describe('WSL Git read environment probe', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    execFileSyncMock.mockReset()
    spawnMock.mockReset()
    resetWslGitReadEnvironmentForTests()
    resetWslLinkedWorktreeGitRoutingForTests()
  })

  afterEach(() => {
    _resetGitAdmissionForTests()
    resetWslGitReadEnvironmentForTests()
    resetWslLinkedWorktreeGitRoutingForTests()
  })

  it('retries a transient environment probe after a bounded delay', async () => {
    let now = 1_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      execFileMock.mockImplementationOnce((_command, _args, _options, callback) => {
        const child = createMockChild()
        queueMicrotask(() =>
          callback?.(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), '', '')
        )
        return child
      })
      // No Git on the distro's default PATH either, so there is no shell-free fallback.
      execFileMock.mockImplementationOnce((_command, _args, _options, callback) => {
        const child = createMockChild()
        queueMicrotask(() =>
          callback?.(Object.assign(new Error('exit 127'), { code: 127 }), '', '')
        )
        return child
      })

      await expect(getWslGitReadEnvironment(DISTRO)).resolves.toBeNull()
      await expect(getWslGitReadEnvironment(DISTRO)).resolves.toBeNull()
      expect(execFileMock).toHaveBeenCalledTimes(2)
      expect(execFileMock.mock.calls[1]?.[1]?.slice(3, 5)).toEqual(['sh', '-c'])

      now += 30_000
      execFileMock.mockImplementationOnce((_command, _args, _options, callback) => {
        const child = createMockChild()
        queueMicrotask(() =>
          callback?.(
            null,
            fencedProbeStdout(execFileMock.mock.calls.at(-1)?.[1]?.[5], LOGIN_ENVIRONMENT_FIELDS),
            ''
          )
        )
        return child
      })

      await expect(getWslGitReadEnvironment(DISTRO)).resolves.toEqual(LOGIN_ENVIRONMENT)
      expect(execFileMock).toHaveBeenCalledTimes(3)
    } finally {
      nowSpy.mockRestore()
    }
  })

  describe('when the login shell is too slow to answer the probe', () => {
    const SHELL_FREE_ENVIRONMENT = {
      gitPath: '/usr/bin/git',
      home: '/home/user',
      path: '/usr/local/bin:/usr/bin:/bin'
    }
    const SHELL_FREE_ENVIRONMENT_FIELDS = `${SHELL_FREE_ENVIRONMENT.path}\0${SHELL_FREE_ENVIRONMENT.gitPath}\0${SHELL_FREE_ENVIRONMENT.home}`
    // A repo inside the distro, so the read routes by its UNC path alone.
    const READ_OPTIONS = { cwd: String.raw`\\wsl.localhost\Ubuntu\repo` }

    function isLoginProbe(args: unknown): boolean {
      const argv = args as string[]
      return argv[4] === '-lc' && String(argv[5]).includes('_orca_git_path')
    }

    function isShellFreeProbe(args: unknown): boolean {
      const argv = args as string[]
      return argv[4] === '-c' && String(argv[5]).includes('_orca_git_path')
    }

    /** Answer a Git read and close the child, which is what releases its admission slot. */
    function answerRead(
      child: MockChild,
      callback: ((error: Error | null, stdout: string, stderr: string) => void) | undefined
    ): void {
      queueMicrotask(() => {
        callback?.(null, 'ok', '')
        child.emit('close', 0, null)
      })
    }

    function killedByTimeout(): Error {
      // What execFile reports when its `timeout` kills the child.
      return Object.assign(new Error('Command failed'), {
        code: null,
        killed: true,
        signal: 'SIGTERM'
      })
    }

    it('serves reads from a Git found without running rc files', async () => {
      await withPlatform('win32', async () => {
        execFileMock.mockImplementation((_command, args, _options, callback) => {
          const child = createMockChild()
          if (isLoginProbe(args)) {
            queueMicrotask(() => callback?.(killedByTimeout(), '', ''))
          } else if (isShellFreeProbe(args)) {
            queueMicrotask(() => callback?.(null, SHELL_FREE_ENVIRONMENT_FIELDS, ''))
          } else {
            answerRead(child, callback)
          }
          return child
        })

        await expect(getWslGitReadEnvironment(DISTRO)).resolves.toEqual(SHELL_FREE_ENVIRONMENT)
        const shellFreeProbe = execFileMock.mock.calls[1]?.[1] as string[]
        expect(shellFreeProbe.slice(0, 5)).toEqual(['-d', DISTRO, '--exec', 'sh', '-c'])
        // Nothing that would source the user's profile or rc files.
        expect(shellFreeProbe[5]).not.toContain('_orca_wsl_shell')
        expect(shellFreeProbe[5]).not.toContain('-ilc')

        await gitExecFileAsync(['status', '--short'], READ_OPTIONS)
        const read = execFileMock.mock.calls.at(-1)?.[1] as string[]
        expect(read).toContain('/usr/bin/env')
        expect(read).toContain(`PATH=${SHELL_FREE_ENVIRONMENT.path}`)
        expect(read).toContain(SHELL_FREE_ENVIRONMENT.gitPath)
        expect(read).not.toContain('-lc')
      })
    })

    it('keeps reads on the fallback while the login probe retries, then upgrades', async () => {
      await withPlatform('win32', async () => {
        // Why real time plus an offset: Git admission measures elapsed time, so a frozen clock stalls it.
        const realNow = Date.now.bind(Date)
        let skipped = 0
        const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skipped)
        try {
          let loginProbeCount = 0
          let completeRetriedLoginProbe:
            | ((error: Error | null, stdout: string, stderr: string) => void)
            | undefined
          execFileMock.mockImplementation((_command, args, _options, callback) => {
            const child = createMockChild()
            if (isLoginProbe(args)) {
              loginProbeCount += 1
              if (loginProbeCount === 1) {
                queueMicrotask(() => callback?.(killedByTimeout(), '', ''))
              } else {
                completeRetriedLoginProbe = callback
              }
            } else if (isShellFreeProbe(args)) {
              queueMicrotask(() => callback?.(null, SHELL_FREE_ENVIRONMENT_FIELDS, ''))
            } else {
              answerRead(child, callback)
            }
            return child
          })

          await expect(getWslGitReadEnvironment(DISTRO)).resolves.toEqual(SHELL_FREE_ENVIRONMENT)

          // Inside the fallback window a read does not start the slow login shell again.
          skipped += 60_000
          await gitExecFileAsync(['status', '--short'], READ_OPTIONS)
          expect(loginProbeCount).toBe(1)

          skipped += 5 * 60_000
          await gitExecFileAsync(['status', '--short'], READ_OPTIONS)
          expect(loginProbeCount).toBe(2)
          // The read that kicked off the retry still ran on the fallback, not the login shell.
          expect(execFileMock.mock.calls.at(-1)?.[1]).toContain(
            `PATH=${SHELL_FREE_ENVIRONMENT.path}`
          )
          expect(peekWslGitReadEnvironment(DISTRO)).toEqual(SHELL_FREE_ENVIRONMENT)

          const loginProbeArgs = execFileMock.mock.calls.filter(([, args]) => isLoginProbe(args))
          completeRetriedLoginProbe?.(
            null,
            fencedProbeStdout(loginProbeArgs.at(-1)?.[1]?.[5], LOGIN_ENVIRONMENT_FIELDS),
            ''
          )
          await expect(getWslGitReadEnvironment(DISTRO)).resolves.toEqual(LOGIN_ENVIRONMENT)
          expect(peekWslGitReadEnvironment(DISTRO)).toEqual(LOGIN_ENVIRONMENT)

          // Upgraded for good: much later reads no longer retry anything.
          skipped += 60 * 60_000
          await gitExecFileAsync(['status', '--short'], READ_OPTIONS)
          expect(loginProbeCount).toBe(2)
          expect(execFileMock.mock.calls.at(-1)?.[1]).toContain(`PATH=${LOGIN_ENVIRONMENT.path}`)
        } finally {
          nowSpy.mockRestore()
        }
      })
    })

    it('does not bypass a login shell that rejects the direct route', async () => {
      // Exit 78: the login environment sets Git-relevant variables, so Git must see that shell.
      execFileMock.mockImplementation((_command, _args, _options, callback) => {
        const child = createMockChild()
        queueMicrotask(() => callback?.(Object.assign(new Error('exit 78'), { code: 78 }), '', ''))
        return child
      })

      await expect(getWslGitReadEnvironment(DISTRO)).resolves.toBeNull()
      expect(execFileMock).toHaveBeenCalledTimes(1)
      expect(execFileMock.mock.calls[0]?.[1]?.slice(3, 5)).toEqual(['sh', '-lc'])
    })

    it('drops the fallback when the direct route is invalidated', async () => {
      execFileMock.mockImplementation((_command, args, _options, callback) => {
        const child = createMockChild()
        if (isLoginProbe(args)) {
          queueMicrotask(() => callback?.(killedByTimeout(), '', ''))
        } else {
          queueMicrotask(() => callback?.(null, SHELL_FREE_ENVIRONMENT_FIELDS, ''))
        }
        return child
      })

      await expect(getWslGitReadEnvironment(DISTRO)).resolves.toEqual(SHELL_FREE_ENVIRONMENT)
      disableWslGitReadEnvironment(DISTRO)
      expect(peekWslGitReadEnvironment(DISTRO)).toBeNull()
      await expect(getWslGitReadEnvironment(DISTRO)).resolves.toBeNull()
      expect(execFileMock).toHaveBeenCalledTimes(2)
    })
  })
})
