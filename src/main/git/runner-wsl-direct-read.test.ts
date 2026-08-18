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

import { gitExecFileAsync, gitSpawn, gitStreamStdout } from './runner'
import {
  getWslGitReadEnvironment,
  resetWslGitReadEnvironmentForTests,
  seedWslGitReadEnvironmentForTests
} from './wsl-git-read-environment'
import {
  prepareWslLinkedWorktreeGitRouting,
  resetWslLinkedWorktreeGitRoutingForTests,
  WSL_LINKED_WORKTREE_ROUTE_TTL_MS,
  type WslLinkedWorktreeRoutingFileSystem
} from './wsl-linked-worktree-git-routing'

const DISTRO = 'Ubuntu'
const LOGIN_ENVIRONMENT = {
  gitPath: '/home/user/bin/git',
  home: '/home/user',
  path: '/home/user/bin:/usr/bin:/bin'
}

/** Stand in for the guest shell: rc chatter first, then the payload inside the command's own fence. */
function fencedProbeStdout(command: unknown, payload: string): string {
  const nonce = /__ORCA_WSL_CAPTURE_BEGIN_([^_]+)__/.exec(String(command))?.[1] ?? ''
  return `profile banner\n__ORCA_WSL_CAPTURE_BEGIN_${nonce}__${payload}__ORCA_WSL_CAPTURE_END_${nonce}__`
}

const LOGIN_ENVIRONMENT_FIELDS = `${LOGIN_ENVIRONMENT.path}\0${LOGIN_ENVIRONMENT.gitPath}\0${LOGIN_ENVIRONMENT.home}`

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

      await expect(getWslGitReadEnvironment(DISTRO)).resolves.toBeNull()
      await expect(getWslGitReadEnvironment(DISTRO)).resolves.toBeNull()
      expect(execFileMock).toHaveBeenCalledTimes(1)

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
      expect(execFileMock).toHaveBeenCalledTimes(2)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('runs an opted-in read directly with translated cwd and arguments', async () => {
    await withPlatform('win32', async () => {
      seedWslGitReadEnvironmentForTests(DISTRO, LOGIN_ENVIRONMENT)
      succeedExecFile()

      await gitExecFileAsync(['status', '--short', String.raw`C:\repo\file.txt`], {
        cwd: String.raw`C:\repo`,
        env: { GIT_OPTIONAL_LOCKS: '0' },
        preferWslDirectGit: true,
        wslDistro: DISTRO
      })

      expect(execFileMock.mock.calls[0]?.[0]).toBe('wsl.exe')
      expect(execFileMock.mock.calls[0]?.[1]).toEqual([
        '-d',
        DISTRO,
        '--exec',
        '/usr/bin/env',
        `PATH=${LOGIN_ENVIRONMENT.path}`,
        `HOME=${LOGIN_ENVIRONMENT.home}`,
        'LANGUAGE=en',
        'LC_ALL=en_US.UTF-8',
        'LANG=en_US.UTF-8',
        'GIT_OPTIONAL_LOCKS=0',
        LOGIN_ENVIRONMENT.gitPath,
        '-C',
        '/mnt/c/repo',
        'status',
        '--short',
        '/mnt/c/repo/file.txt'
      ])
    })
  })

  it('keeps the first read on the login shell while priming the fast path', async () => {
    await withPlatform('win32', async () => {
      let completeProbe: ((error: Error | null, stdout: string, stderr: string) => void) | undefined
      execFileMock.mockImplementation((_command, args, _options, callback) => {
        const child = createMockChild()
        if ((args as string[])[5]?.includes('^GIT_')) {
          completeProbe = callback
        } else {
          queueMicrotask(() => callback?.(null, 'ok', ''))
        }
        return child
      })

      const options = {
        cwd: String.raw`C:\repo`,
        preferWslDirectGit: true as const,
        wslDistro: DISTRO
      }
      await gitExecFileAsync(['status', '--short'], options)

      expect(execFileMock).toHaveBeenCalledTimes(2)
      expect(execFileMock.mock.calls[1]?.[1]?.slice(3, 5)).toEqual(['sh', '-lc'])
      completeProbe?.(
        null,
        fencedProbeStdout(execFileMock.mock.calls[1]?.[1]?.[5], LOGIN_ENVIRONMENT_FIELDS),
        ''
      )
      await Promise.resolve()
      await gitExecFileAsync(['status', '--short'], options)
      expect(execFileMock.mock.calls[2]?.[1]).toContain('--exec')
    })
  })

  it('keeps unopted commands on the WSL login shell', async () => {
    await withPlatform('win32', async () => {
      seedWslGitReadEnvironmentForTests(DISTRO, LOGIN_ENVIRONMENT)
      succeedExecFile()

      await gitExecFileAsync(['add', '--', 'file.txt'], {
        cwd: String.raw`C:\repo`,
        wslDistro: DISTRO
      })

      expect(execFileMock.mock.calls[0]?.[1]?.slice(3, 5)).toEqual(['sh', '-lc'])
    })
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

  it('ignores unchanged ambient host Git variables when selecting the direct path', async () => {
    await withPlatform('win32', async () => {
      const originalAskpass = process.env.GIT_ASKPASS
      process.env.GIT_ASKPASS = String.raw`C:\host\askpass.exe`
      try {
        seedWslGitReadEnvironmentForTests(DISTRO, LOGIN_ENVIRONMENT)
        succeedExecFile()

        await gitExecFileAsync(['status', '--short'], {
          cwd: String.raw`C:\repo`,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
          preferWslDirectGit: true,
          wslDistro: DISTRO
        })

        expect(execFileMock.mock.calls[0]?.[1]).toContain('--exec')
      } finally {
        if (originalAskpass === undefined) {
          delete process.env.GIT_ASKPASS
        } else {
          process.env.GIT_ASKPASS = originalAskpass
        }
      }
    })
  })

  it('leaves override-less WSL UNC routing on its existing non-login shell', async () => {
    await withPlatform('win32', async () => {
      seedWslGitReadEnvironmentForTests(DISTRO, LOGIN_ENVIRONMENT)
      succeedExecFile()

      await gitExecFileAsync(['status', '--short'], {
        cwd: String.raw`\\wsl.localhost\Ubuntu\repo`,
        preferWslDirectGit: true
      })

      expect(execFileMock.mock.calls[0]?.[1]?.slice(3, 5)).toEqual(['bash', '-c'])
    })
  })

  it('invalidates a missing direct executable and retries through the login shell', async () => {
    await withPlatform('win32', async () => {
      seedWslGitReadEnvironmentForTests(DISTRO, LOGIN_ENVIRONMENT)
      execFileMock.mockImplementationOnce((_command, _args, _options, callback) => {
        const child = createMockChild()
        queueMicrotask(() =>
          callback?.(
            Object.assign(new Error('exit 127'), { code: 127 }),
            '',
            '/usr/bin/env: No such file or directory'
          )
        )
        return child
      })
      execFileMock.mockImplementationOnce((_command, _args, _options, callback) => {
        const child = createMockChild()
        queueMicrotask(() => callback?.(null, 'ok', ''))
        return child
      })

      await expect(
        gitExecFileAsync(['status', '--short'], {
          cwd: String.raw`C:\repo`,
          preferWslDirectGit: true,
          wslDistro: DISTRO
        })
      ).resolves.toEqual({ stdout: 'ok', stderr: '' })

      expect(execFileMock.mock.calls[0]?.[1]).toContain('--exec')
      expect(execFileMock.mock.calls[1]?.[1]?.slice(3, 5)).toEqual(['sh', '-lc'])
    })
  })

  it('falls back and disables the fast path after another direct Git failure', async () => {
    await withPlatform('win32', async () => {
      seedWslGitReadEnvironmentForTests(DISTRO, LOGIN_ENVIRONMENT)
      execFileMock.mockImplementationOnce((_command, _args, _options, callback) => {
        const child = createMockChild()
        queueMicrotask(() =>
          callback?.(Object.assign(new Error('exit 128'), { code: 128 }), '', 'helper failed')
        )
        return child
      })
      execFileMock.mockImplementation((_command, _args, _options, callback) => {
        const child = createMockChild()
        queueMicrotask(() => callback?.(null, 'ok', ''))
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

  it('keeps the fast path when direct and login Git both report an expected failure', async () => {
    await withPlatform('win32', async () => {
      seedWslGitReadEnvironmentForTests(DISTRO, LOGIN_ENVIRONMENT)
      execFileMock
        .mockImplementationOnce((_command, _args, _options, callback) => {
          const child = createMockChild()
          queueMicrotask(() =>
            callback?.(Object.assign(new Error('exit 128'), { code: 128 }), '', 'missing ref')
          )
          return child
        })
        .mockImplementationOnce((_command, _args, _options, callback) => {
          const child = createMockChild()
          queueMicrotask(() =>
            callback?.(Object.assign(new Error('exit 128'), { code: 128 }), '', 'missing ref')
          )
          return child
        })
        .mockImplementationOnce((_command, _args, _options, callback) => {
          const child = createMockChild()
          queueMicrotask(() => callback?.(null, 'ok', ''))
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

  it('streams opted-in reads directly', async () => {
    await withPlatform('win32', async () => {
      seedWslGitReadEnvironmentForTests(DISTRO, LOGIN_ENVIRONMENT)
      spawnMock.mockImplementation(() => {
        const child = createMockChild()
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from('# branch.head main\n'))
          child.emit('close', 0)
        })
        return child
      })
      const chunks: string[] = []

      await gitStreamStdout(['status', '--porcelain=v2'], {
        cwd: String.raw`C:\repo`,
        onStdout: (chunk) => {
          chunks.push(chunk)
        },
        preferWslDirectGit: true,
        wslDistro: DISTRO
      })

      expect(chunks).toEqual(['# branch.head main\n'])
      expect(spawnMock.mock.calls[0]?.[1]).toContain('--exec')
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

  it('leaves non-Windows execution unchanged', async () => {
    await withPlatform('linux', async () => {
      seedWslGitReadEnvironmentForTests(DISTRO, LOGIN_ENVIRONMENT)
      succeedExecFile()

      await gitExecFileAsync(['status', '--short'], {
        cwd: '/repo',
        preferWslDirectGit: true,
        wslDistro: DISTRO
      })

      expect(execFileMock.mock.calls[0]?.[0]).toBe('git')
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

  it('aborts an async Git call while linked-worktree discovery remains pending', async () => {
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

      const command = gitExecFileAsync(['status', '--short'], {
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
  })

  it('keeps gitSpawn cache-only when a linked-worktree route expires', async () => {
    await withPlatform('win32', async () => {
      let currentTime = 1_000
      const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => currentTime)
      try {
        const fileSystem: WslLinkedWorktreeRoutingFileSystem = {
          stat: vi.fn(async () => ({ isDirectory: () => false, isFile: () => true })),
          readFile: vi.fn(async () => 'gitdir: C:/main/.git/worktrees/linked\n')
        }
        await prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo`, DISTRO, {
          platform: 'win32',
          fileSystem
        })
        spawnMock.mockReturnValue(createMockChild())

        gitSpawn(['ls-files'], {
          cwd: String.raw`C:\repo`,
          wslDistro: DISTRO,
          stdio: ['ignore', 'pipe', 'pipe']
        })
        currentTime += WSL_LINKED_WORKTREE_ROUTE_TTL_MS
        gitSpawn(['ls-files'], {
          cwd: String.raw`C:\repo`,
          wslDistro: DISTRO,
          stdio: ['ignore', 'pipe', 'pipe']
        })

        expect(spawnMock.mock.calls[0]?.[0]).toBe('git')
        expect(spawnMock.mock.calls[1]?.[0]).toBe('wsl.exe')
        expect(fileSystem.stat).toHaveBeenCalledTimes(1)

        await prepareWslLinkedWorktreeGitRouting(String.raw`C:\repo`, DISTRO, {
          platform: 'win32',
          fileSystem
        })
        gitSpawn(['ls-files'], {
          cwd: String.raw`C:\repo`,
          wslDistro: DISTRO,
          stdio: ['ignore', 'pipe', 'pipe']
        })
        expect(fileSystem.stat).toHaveBeenCalledTimes(2)
        expect(spawnMock.mock.calls[2]?.[0]).toBe('git')
      } finally {
        nowSpy.mockRestore()
      }
    })
  })
})
