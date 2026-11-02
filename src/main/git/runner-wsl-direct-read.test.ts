import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeSpawnedChild } from '../../shared/__fixtures__/fake-spawned-child'

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

import { getBranchConflictKind } from './repo-branch-conflict'
import { pendingWslDirectGitReadEnvironment } from './command-runner/git-command-resolution'
import { gitExecFileAsync, gitExecFileAsyncBuffer, gitSpawn, gitStreamStdout } from './runner'
import {
  GitAdmissionScheduler,
  _resetGitAdmissionForTests,
  type GitAdmissionEvent
} from './command-runner/git-subprocess-admission'
import {
  getWslGitReadEnvironment,
  resetWslGitReadEnvironmentForTests,
  seedWslGitReadEnvironmentForTests,
  WSL_GIT_READ_ENVIRONMENT_WAIT_MS
} from './wsl-git-read-environment'
import {
  prepareWslLinkedWorktreeGitRouting,
  resetWslLinkedWorktreeGitRoutingForTests,
  type WslLinkedWorktreeRoutingFileSystem
} from './wsl-linked-worktree-git-routing'

afterEach(() => _resetGitAdmissionForTests())

const DISTRO = 'Ubuntu'
const LOGIN_ENVIRONMENT = {
  gitPath: '/home/user/bin/git',
  home: '/home/user',
  path: '/home/user/bin:/usr/bin:/bin'
}

/** Stand in for the guest shell: rc chatter first, then the payload inside the command's own fence. */
function fencedProbeStdout(command: unknown, payload: string): string {
  const nonce = /__ORCA_WSL_CAPTURE_BEGIN_ ([^_]+)__/.exec(String(command))?.[1] ?? ''
  return `profile banner\n__ORCA_WSL_CAPTURE_BEGIN_${nonce}__${payload}__ORCA_WSL_CAPTURE_END_${nonce}__`
}

function createMockChild() {
  return createFakeSpawnedChild(1234)
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

function succeedExecFile(stdout = 'ok'): void {
  execFileMock.mockImplementation((_command, _args, _options, callback) => {
    const child = createMockChild()
    queueMicrotask(() => callback?.(null, stdout, ''))
    return child
  })
}

describe('WSL direct Git reads', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    execFileSyncMock.mockReset()
    spawnMock.mockReset()
    resetWslGitReadEnvironmentForTests()
    resetWslLinkedWorktreeGitRoutingForTests()
  })

  afterEach(() => {
    resetWslGitReadEnvironmentForTests()
    resetWslLinkedWorktreeGitRoutingForTests()
  })

  it('coalesces the login-shell environment probe per distro', async () => {
    let completeProbe: ((error: Error | null, stdout: string, stderr: string) => void) | undefined
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      completeProbe = callback
      return createMockChild()
    })

    const first = getWslGitReadEnvironment(DISTRO)
    const second = getWslGitReadEnvironment(DISTRO)
    expect(execFileMock).toHaveBeenCalledTimes(1)
    completeProbe?.(
      null,
      fencedProbeStdout(
        execFileMock.mock.calls[0]?.[1]?.[5],
        '/home/user/bin:/usr/bin\0/home/user/bin/git\0/home/user'
      ),
      ''
    )

    await expect(Promise.all([first, second])).resolves.toEqual([
      { gitPath: '/home/user/bin/git', home: '/home/user', path: '/home/user/bin:/usr/bin' },
      { gitPath: '/home/user/bin/git', home: '/home/user', path: '/home/user/bin:/usr/bin' }
    ])
    expect(execFileMock.mock.calls[0]?.[1]?.slice(3, 5)).toEqual(['sh', '-lc'])
    expect(execFileMock.mock.calls[0]?.[1]?.[5]).toContain('^GIT_')
  })

  it('keeps reads with custom Git environment policy on the login shell', async () => {
    await withPlatform('win32', async () => {
      seedWslGitReadEnvironmentForTests(DISTRO, LOGIN_ENVIRONMENT)
      succeedExecFile()

      await gitExecFileAsync(['status', '--short'], {
        cwd: String.raw`C:\repo`,
        env: { GIT_CONFIG_GLOBAL: '/home/user/custom.gitconfig' },
        preferWslDirectGit: true,
        wslDistro: DISTRO
      })

      expect(execFileMock.mock.calls[0]?.[1]?.slice(3, 5)).toEqual(['sh', '-lc'])
    })
  })

  it('fences parsed output from a barrier Git login-shell fallback', async () => {
    await withPlatform('win32', async () => {
      seedWslGitReadEnvironmentForTests(DISTRO, LOGIN_ENVIRONMENT)
      spawnMock.mockImplementation((_command, args) => {
        const child = createMockChild()
        queueMicrotask(() => {
          const capturedCommand = args?.find((arg) =>
            String(arg).includes('__ORCA_WSL_CAPTURE_BEGIN_')
          )
          const fenced = fencedProbeStdout(capturedCommand, 'fork-point\n')
          const echoedMarker = fenced.match(/__ORCA_WSL_CAPTURE_BEGIN_[^_]+__/)?.[0] ?? ''
          child.stdout.emit('data', Buffer.from(`${echoedMarker}shell trace\n${fenced}`))
          child.emit('close', 0, null)
        })
        return child
      })

      await expect(
        gitExecFileAsync(['merge-base', '--fork-point', 'upstream/main', 'HEAD'], {
          cwd: String.raw`C:\repo`,
          env: { GIT_CONFIG_GLOBAL: '/home/user/custom.gitconfig' },
          wslDistro: DISTRO,
          terminationBarrier: true
        })
      ).resolves.toEqual({ stdout: 'fork-point\n', stderr: '' })

      expect(spawnMock.mock.calls[0]?.[1]?.join(' ')).toContain('setsid --wait')
      expect(spawnMock.mock.calls[0]?.[1]?.join(' ')).toContain('__ORCA_WSL_CAPTURE_BEGIN_')
    })
  })

  it('verifies the WSL guest process group before settling an abort', async () => {
    await withPlatform('win32', async () => {
      seedWslGitReadEnvironmentForTests(DISTRO, LOGIN_ENVIRONMENT)
      const command = createMockChild()
      spawnMock.mockImplementation((_program, args) => {
        if (spawnMock.mock.calls.length === 1) {
          queueMicrotask(() => {
            const marker = String(args?.join(' ')).match(
              /(__ORCA_WSL_PROCESS_GROUP_[0-9a-f-]+__=)/
            )?.[1]
            command.stderr.emit('data', Buffer.from(`${marker}4321\n`))
          })
          return command
        }
        const terminator = createMockChild()
        queueMicrotask(() => {
          // The kill first confirms the distro still runs, so it cannot boot a stopped one (E9).
          if (args?.includes('--running')) {
            terminator.stdout.emit('data', Buffer.from(`${DISTRO}\n`))
          }
          terminator.emit('close', 0, null)
        })
        return terminator
      })
      const controller = new AbortController()
      const pending = gitExecFileAsync(['status'], {
        cwd: String.raw`C:\repo`,
        env: { GIT_CONFIG_GLOBAL: '/home/user/custom.gitconfig' },
        wslDistro: DISTRO,
        signal: controller.signal,
        terminationBarrier: true
      })
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1))
      await Promise.resolve()

      controller.abort()

      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      expect(command.kill).not.toHaveBeenCalled()
      const kill = spawnMock.mock.calls.find(([, args]) =>
        String(args?.join(' ')).includes('kill -TERM')
      )
      expect(kill?.[1]).toContain('4321')
    })
  })

  it('stops waiting for a wedged probe and reads through the shell route', async () => {
    await withPlatform('win32', async () => {
      vi.useFakeTimers()
      try {
        execFileMock.mockImplementation((_command, args, _options, callback) => {
          const child = createMockChild()
          if (!String(args).includes('_orca_git_path')) {
            queueMicrotask(() => callback?.(null, 'ok', ''))
          }
          return child
        })

        const pending = gitExecFileAsync(['show', ':src/file.ts'], {
          cwd: String.raw`\\wsl.localhost\Ubuntu\repo`
        })
        await vi.advanceTimersByTimeAsync(WSL_GIT_READ_ENVIRONMENT_WAIT_MS)
        await pending

        const resolved = execFileMock.mock.calls.at(-1)?.[1] ?? []
        expect(resolved.slice(3, 5)).toEqual(['bash', '-c'])
        expect(resolved).not.toContain('/usr/bin/env')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('stops waiting for a cold probe as soon as the read aborts', async () => {
    await withPlatform('win32', async () => {
      vi.useFakeTimers()
      try {
        execFileMock.mockImplementation(() => createMockChild())
        const controller = new AbortController()

        const pending = pendingWslDirectGitReadEnvironment(['show', ':src/file.ts'], {
          cwd: String.raw`\\wsl.localhost\Ubuntu\repo`,
          signal: controller.signal
        })
        controller.abort()

        await expect(pending).resolves.toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('waits for direct Git to close before retrying through the login shell', async () => {
    await withPlatform('win32', async () => {
      const admissionEvents: GitAdmissionEvent[] = []
      _resetGitAdmissionForTests(
        new GitAdmissionScheduler({ onAdmissionEvent: (event) => admissionEvents.push(event) })
      )
      seedWslGitReadEnvironmentForTests(DISTRO, LOGIN_ENVIRONMENT)
      let directChild!: ReturnType<typeof createMockChild>
      execFileMock.mockImplementationOnce((_command, _args, _options, callback) => {
        const child = createMockChild()
        directChild = child
        queueMicrotask(() => {
          callback?.(
            Object.assign(new Error('exit 127'), { code: 127 }),
            '',
            '/usr/bin/env: No such file or directory'
          )
        })
        return child
      })
      execFileMock.mockImplementationOnce((_command, _args, _options, callback) => {
        const child = createMockChild()
        queueMicrotask(() => {
          child.emit('close', 0, null)
          callback?.(null, 'ok', '')
        })
        return child
      })

      const result = gitExecFileAsync(['status', '--short'], {
        cwd: String.raw`C:\repo`,
        preferWslDirectGit: true,
        wslDistro: DISTRO
      })

      await vi.waitFor(() => expect(directChild).toBeDefined())
      await Promise.resolve()
      expect(execFileMock).toHaveBeenCalledTimes(1)
      directChild.emit('close', 127, null)
      await expect(result).resolves.toEqual({ stdout: 'ok', stderr: '' })

      expect(execFileMock.mock.calls[0]?.[1]).toContain('--exec')
      expect(execFileMock.mock.calls[1]?.[1]?.slice(3, 5)).toEqual(['sh', '-lc'])
      expect(admissionEvents.map(({ phase, waiterId }) => [phase, waiterId])).toEqual([
        ['grant', 0],
        ['release', 0]
      ])
    })
  })

  it('falls back and disables the fast path after another direct Git failure', async () => {
    await withPlatform('win32', async () => {
      seedWslGitReadEnvironmentForTests(DISTRO, LOGIN_ENVIRONMENT)
      execFileMock.mockImplementationOnce((_command, _args, _options, callback) => {
        const child = createMockChild()
        queueMicrotask(() => {
          callback?.(Object.assign(new Error('exit 128'), { code: 128 }), '', 'helper failed')
          child.emit('close', 128, null)
        })
        return child
      })
      execFileMock.mockImplementation((_command, _args, _options, callback) => {
        const child = createMockChild()
        queueMicrotask(() => {
          callback?.(null, 'ok', '')
          child.emit('close', 0, null)
        })
        return child
      })
      const options = {
        cwd: String.raw`C:\repo`,
        preferWslDirectGit: true as const,
        wslDistro: DISTRO
      }

      await gitExecFileAsync(['status', '--short'], options)
      await gitExecFileAsync(['status', '--short'], options)

      expect(execFileMock.mock.calls[0]?.[1]).toContain('--exec')
      expect(execFileMock.mock.calls[1]?.[1]?.slice(3, 5)).toEqual(['sh', '-lc'])
      expect(execFileMock.mock.calls[2]?.[1]?.slice(3, 5)).toEqual(['sh', '-lc'])
    })
  })

  it('checks a missing branch conflict without retrying through a login shell', async () => {
    await withPlatform('win32', async () => {
      seedWslGitReadEnvironmentForTests(DISTRO, LOGIN_ENVIRONMENT)
      execFileMock.mockImplementation((_command, args: string[], _options, callback) => {
        const child = createMockChild()
        queueMicrotask(() => {
          const missingRef = args.join(' ').includes('rev-parse')
          const quiet = args.includes('--quiet')
          const code = missingRef ? (quiet ? 1 : 128) : 0
          callback?.(
            code ? Object.assign(new Error('missing ref'), { code }) : null,
            '',
            missingRef && !quiet ? 'fatal: Needed a single revision' : ''
          )
          child.emit('close', code, null)
        })
        return child
      })

      await expect(
        getBranchConflictKind(String.raw`\\wsl.localhost\Ubuntu\repo`, 'new-feature')
      ).resolves.toBeNull()
      expect(execFileMock).toHaveBeenCalledTimes(3)
      expect(execFileMock.mock.calls[0]?.[1]).toContain('--quiet')
    })
  })

  it('keeps the fast path when direct and login Git both report an expected failure', async () => {
    await withPlatform('win32', async () => {
      seedWslGitReadEnvironmentForTests(DISTRO, LOGIN_ENVIRONMENT)
      execFileMock
        .mockImplementationOnce((_command, _args, _options, callback) => {
          const child = createMockChild()
          queueMicrotask(() => {
            callback?.(Object.assign(new Error('exit 128'), { code: 128 }), '', 'missing ref')
            child.emit('close', 128, null)
          })
          return child
        })
        .mockImplementationOnce((_command, _args, _options, callback) => {
          const child = createMockChild()
          queueMicrotask(() => {
            callback?.(Object.assign(new Error('exit 128'), { code: 128 }), '', 'missing ref')
            child.emit('close', 128, null)
          })
          return child
        })
        .mockImplementationOnce((_command, _args, _options, callback) => {
          const child = createMockChild()
          queueMicrotask(() => {
            callback?.(null, 'ok', '')
            child.emit('close', 0, null)
          })
          return child
        })
      const options = {
        cwd: String.raw`C:\repo`,
        preferWslDirectGit: true as const,
        wslDistro: DISTRO
      }

      await expect(gitExecFileAsync(['rev-parse', '--verify', 'missing'], options)).rejects.toThrow(
        'exit 128'
      )
      await gitExecFileAsync(['status', '--short'], options)

      expect(execFileMock.mock.calls[0]?.[1]).toContain('--exec')
      expect(execFileMock.mock.calls[1]?.[1]?.slice(3, 5)).toEqual(['sh', '-lc'])
      expect(execFileMock.mock.calls[2]?.[1]).toContain('--exec')
    })
  })

  it('retries a direct stream only when no stdout was delivered', async () => {
    await withPlatform('win32', async () => {
      seedWslGitReadEnvironmentForTests(DISTRO, LOGIN_ENVIRONMENT)
      spawnMock
        .mockImplementationOnce(() => {
          const child = createMockChild()
          queueMicrotask(() => {
            child.stderr.emit('data', Buffer.from('/usr/bin/env: No such file or directory'))
            child.emit('close', 127)
          })
          return child
        })
        .mockImplementationOnce(() => {
          const child = createMockChild()
          queueMicrotask(() => {
            child.stdout.emit('data', Buffer.from('# branch.head main\n'))
            child.emit('close', 0)
          })
          return child
        })

      await gitStreamStdout(['status', '--porcelain=v2'], {
        cwd: String.raw`C:\repo`,
        onStdout: () => {},
        preferWslDirectGit: true,
        wslDistro: DISTRO
      })

      expect(spawnMock).toHaveBeenCalledTimes(2)
      expect(spawnMock.mock.calls[0]?.[1]).toContain('--exec')
      expect(spawnMock.mock.calls[1]?.[1]?.slice(3, 5)).toEqual(['sh', '-lc'])
    })
  })

  it('does not retry a failed direct stream after delivering output', async () => {
    await withPlatform('win32', async () => {
      seedWslGitReadEnvironmentForTests(DISTRO, LOGIN_ENVIRONMENT)
      spawnMock.mockImplementation(() => {
        const child = createMockChild()
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from('partial'))
          child.stderr.emit('data', Buffer.from('/usr/bin/env: No such file or directory'))
          child.emit('close', 127)
        })
        return child
      })

      await expect(
        gitStreamStdout(['status', '--porcelain=v2'], {
          cwd: String.raw`C:\repo`,
          onStdout: () => {},
          preferWslDirectGit: true,
          wslDistro: DISTRO
        })
      ).rejects.toThrow('git exited with 127')
      expect(spawnMock).toHaveBeenCalledTimes(1)
    })
  })

  it('keeps network reads on the login shell even if opted in', async () => {
    await withPlatform('win32', async () => {
      seedWslGitReadEnvironmentForTests(DISTRO, LOGIN_ENVIRONMENT)
      succeedExecFile()

      await gitExecFileAsync(['fetch', '--dry-run'], {
        cwd: String.raw`C:\repo`,
        preferWslDirectGit: true,
        useConfiguredSshCommandForNetwork: true,
        wslDistro: DISTRO
      })

      expect(
        execFileMock.mock.calls.every((call) => call[1]?.slice(3, 5).join(' ') === 'sh -lc')
      ).toBe(true)
    })
  })

  it('keeps gitSpawn cache-only while async linked-worktree discovery is pending', async () => {
    await withPlatform('win32', async () => {
      let releaseStat: (() => void) | undefined
      const delayedStat = new Promise<void>((resolve) => {
        releaseStat = resolve
      })
      const fileSystem: WslLinkedWorktreeRoutingFileSystem = {
        stat: vi.fn(async () => {
          await delayedStat
          return { isDirectory: () => false, isFile: () => true }
        }),
        readFile: vi.fn(async () => 'gitdir: C:/main/.git/worktrees/linked\n')
      }
      const pending = prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo`, DISTRO, {
        platform: 'win32',
        fileSystem
      })
      spawnMock.mockReturnValue(createMockChild())

      gitSpawn(['ls-files'], {
        cwd: String.raw`C:\repo`,
        wslDistro: DISTRO,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      expect(fileSystem.stat).toHaveBeenCalledTimes(1)
      expect(spawnMock.mock.calls[0]?.[0]).toBe('wsl.exe')
      releaseStat?.()
      await expect(pending).resolves.toBe(true)

      gitSpawn(['ls-files'], {
        cwd: String.raw`C:\repo`,
        wslDistro: DISTRO,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      expect(fileSystem.stat).toHaveBeenCalledTimes(1)
      expect(spawnMock.mock.calls[1]?.[0]).toBe('git')
    })
  })

  it.each([gitExecFileAsync, gitExecFileAsyncBuffer])(
    'aborts an async Git read while linked-worktree discovery remains pending (%s)',
    async (readGit) => {
      await withPlatform('win32', async () => {
        let releaseStat: (() => void) | undefined
        const delayedStat = new Promise<void>((resolve) => {
          releaseStat = resolve
        })
        const fileSystem: WslLinkedWorktreeRoutingFileSystem = {
          stat: vi.fn(async () => {
            await delayedStat
            return { isDirectory: () => false, isFile: () => true }
          }),
          readFile: vi.fn(async () => 'gitdir: C:/main/.git/worktrees/linked\n')
        }
        const discovery = prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo`, DISTRO, {
          platform: 'win32',
          fileSystem
        })
        const controller = new AbortController()

        const command = readGit(['show', 'HEAD:file'], {
          cwd: String.raw`C:\repo`,
          wslDistro: DISTRO,
          signal: controller.signal
        })
        controller.abort()

        await expect(command).rejects.toMatchObject({ name: 'AbortError' })
        expect(execFileMock).not.toHaveBeenCalled()
        releaseStat?.()
        await expect(discovery).resolves.toBe(true)
      })
    }
  )
})
