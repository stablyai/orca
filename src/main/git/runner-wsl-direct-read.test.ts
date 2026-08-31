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

import { pendingWslDirectGitReadEnvironment } from './command-runner/git-command-resolution'
import { gitExecFileAsync, gitSpawn, gitStreamStdout } from './runner'
import {
  GitAdmissionScheduler,
  _resetGitAdmissionForTests,
  type GitAdmissionEvent
} from './command-runner/git-subprocess-admission'
import {
  disableWslGitReadEnvironment,
  getWslGitReadEnvironment,
  resetWslGitReadEnvironmentForTests,
  seedWslGitReadEnvironmentForTests,
  WSL_GIT_READ_ENVIRONMENT_WAIT_MS
} from './wsl-git-read-environment'
import {
  prepareWslLinkedWorktreeGitRouting,
  resetWslLinkedWorktreeGitRoutingForTests,
  WSL_LINKED_WORKTREE_ROUTE_TTL_MS,
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
          captureWslLoginShellOutput: true,
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
        queueMicrotask(() => terminator.emit('close', 0, null))
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
      expect(spawnMock.mock.calls[1]?.[1]?.join(' ')).toContain('kill -TERM')
      expect(spawnMock.mock.calls[1]?.[1]).toContain('4321')
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

  // A UNC worktree names its distro in the path, so a read there needs no resolved WSL project
  // runtime to skip the shell -- requiring one is what kept every diff read on the login shell.
  it('takes the direct read route for an override-less WSL UNC cwd', async () => {
    await withPlatform('win32', async () => {
      seedWslGitReadEnvironmentForTests(DISTRO, LOGIN_ENVIRONMENT)
      succeedExecFile()

      await gitExecFileAsync(['status', '--short'], {
        cwd: String.raw`\\wsl.localhost\Ubuntu\repo`,
        preferWslDirectGit: true
      })

      const resolved = execFileMock.mock.calls[0]?.[1] ?? []
      expect(resolved).toContain('--exec')
      expect(resolved).toContain(`PATH=${LOGIN_ENVIRONMENT.path}`)
      expect(resolved).not.toContain('bash')
    })
  })

  // The classifier already recognizes `show`, so the blob reads behind every diff take the
  // direct route from the cwd alone -- no caller-supplied distro, no explicit opt-in.
  it('takes the direct read route for an unclassified-caller blob read on a UNC cwd', async () => {
    await withPlatform('win32', async () => {
      seedWslGitReadEnvironmentForTests(DISTRO, LOGIN_ENVIRONMENT)
      succeedExecFile()

      await gitExecFileAsync(['show', ':src/file.ts'], {
        cwd: String.raw`\\wsl.localhost\Ubuntu\repo`
      })

      expect(execFileMock.mock.calls[0]?.[1]).toContain('--exec')
    })
  })

  // Kicking the probe off and resolving without it left the reads issued before it
  // answered on the login shell -- the slow route, chosen by nothing but timing.
  it('waits for a cold probe so the first read already skips the shell', async () => {
    await withPlatform('win32', async () => {
      execFileMock.mockImplementation((_command, args, _options, callback) => {
        const child = createMockChild()
        if (String(args).includes('_orca_git_path')) {
          setTimeout(
            () => callback?.(null, fencedProbeStdout(args, LOGIN_ENVIRONMENT_FIELDS), ''),
            0
          )
        } else {
          queueMicrotask(() => callback?.(null, 'ok', ''))
        }
        return child
      })

      await gitExecFileAsync(['show', ':src/file.ts'], {
        cwd: String.raw`\\wsl.localhost\Ubuntu\repo`
      })

      expect(execFileMock.mock.calls.at(-1)?.[1]).toContain('--exec')
      expect(execFileMock.mock.calls.at(-1)?.[1]).toContain(`PATH=${LOGIN_ENVIRONMENT.path}`)
    })
  })

  it('stops waiting for a wedged probe and reads through the shell route', async () => {
    await withPlatform('win32', async () => {
      vi.useFakeTimers()
      try {
        execFileMock.mockImplementation((_command, args, _options, callback) => {
          const child = createMockChild()
          // The probe never answers; only the git command itself does.
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

        // Exactly the routing this read had before the wait existed: an unanswered
        // probe must cost the bound and nothing else.
        const resolved = execFileMock.mock.calls.at(-1)?.[1] ?? []
        expect(resolved.slice(3, 5)).toEqual(['bash', '-c'])
        expect(resolved).not.toContain('/usr/bin/env')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // Once the route is disabled the answer is already known, so paying for a timer and two
  // extra microtask hops on every later read is pure overhead on the host this PR targets.
  it('stops deferring reads once the direct route is disabled for the distro', async () => {
    await withPlatform('win32', async () => {
      seedWslGitReadEnvironmentForTests(DISTRO, LOGIN_ENVIRONMENT)
      disableWslGitReadEnvironment(DISTRO)

      expect(
        pendingWslDirectGitReadEnvironment(['show', ':src/file.ts'], {
          cwd: String.raw`\\wsl.localhost\Ubuntu\repo`
        })
      ).toBeNull()
    })
  })

  it('never waits on the probe for an already-aborted read', async () => {
    await withPlatform('win32', async () => {
      const controller = new AbortController()
      controller.abort()

      expect(
        pendingWslDirectGitReadEnvironment(['show', ':src/file.ts'], {
          cwd: String.raw`\\wsl.localhost\Ubuntu\repo`,
          signal: controller.signal
        })
      ).toBeNull()
      expect(execFileMock).not.toHaveBeenCalled()
    })
  })

  it('stops waiting for a cold probe as soon as the read aborts', async () => {
    await withPlatform('win32', async () => {
      vi.useFakeTimers()
      try {
        // The probe never answers, so only the abort can end the wait.
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
