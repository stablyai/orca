import * as processHost from '@orca/process-host'
import type { ProcessTerminationBarrier } from '@orca/process-host/process-spec'
import { removeLocalWorktreePath } from '../../../workspaces/removal/local-worktree-filesystem'
import { removeWorktree } from '../../worktrees/removal/worktree-removal'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeSpawnedChild } from '../../../../shared/__fixtures__/fake-spawned-child'

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
vi.mock('../../../observability/instrumentation', () => ({
  withGitSpan: (_attributes: unknown, run: () => unknown) => run()
}))
vi.mock('../../../diagnostics/main-thread-churn-probe', () => ({ recordSubprocessSpawn: vi.fn() }))
import { gitExecFileAsync, gitExecFileAsyncBuffer } from '../git-exec-file'
import { gitStreamStdout } from '../git-stream-stdout'

import { _resetGitAdmissionForTests } from '../admission/git-subprocess-admission'

import {
  recordHostAutocrlf,
  resetWslWindowsCheckoutGitConfigForTests,
  wslWindowsCheckoutKey
} from './wsl-windows-checkout-git-config'
import {
  resetWslGitReadEnvironmentForTests,
  seedWslGitReadEnvironmentForTests,
  WSL_GIT_READ_ENVIRONMENT_WAIT_MS
} from './wsl-git-read-environment'
import {
  prepareWslLinkedWorktreeGitRouting,
  resetWslLinkedWorktreeGitRoutingForTests
} from './wsl-linked-worktree-git-routing'
import type { WslLinkedWorktreeRoutingFileSystem } from './wsl-linked-worktree-git-route-probe'

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

describe('WSL direct Git reads', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    execFileSyncMock.mockReset()
    spawnMock.mockReset()
    resetWslGitReadEnvironmentForTests()
    resetWslLinkedWorktreeGitRoutingForTests()
    resetWslWindowsCheckoutGitConfigForTests()
    recordHostAutocrlf(wslWindowsCheckoutKey(String.raw`C:\repo`, DISTRO), 'other', Date.now())
  })

  afterEach(() => {
    resetWslGitReadEnvironmentForTests()
    resetWslLinkedWorktreeGitRoutingForTests()
    resetWslWindowsCheckoutGitConfigForTests()
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

  it.each([
    ['git', true],
    ['git', false],
    ['filesystem', true],
    ['filesystem', false]
  ] as const)(
    'E1 retains %s removal until guest termination is proved: confirmed=%s',
    async (kind, confirmed) => {
      await withPlatform('win32', async () => {
        vi.useFakeTimers()
        seedWslGitReadEnvironmentForTests(DISTRO, LOGIN_ENVIRONMENT)
        const command = createMockChild()
        let guestConfirmed = confirmed
        let barrier: ProcessTerminationBarrier | undefined
        const runProcess = processHost.runProcess
        const processSeam = vi
          .spyOn(processHost, 'runProcess')
          .mockImplementation((spec, capture) => {
            if (spec.terminationBarrier && typeof spec.terminationBarrier === 'object') {
              barrier ??= spec.terminationBarrier
            }
            return runProcess(spec, capture)
          })
        command.kill.mockImplementation(() => {
          queueMicrotask(() => command.emit('close', null, 'SIGKILL'))
          return true
        })
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
            const running = args?.includes('--running')
            if (running) {
              terminator.stdout.emit('data', Buffer.from(`${DISTRO}\n`))
            }
            terminator.emit('close', running || guestConfirmed ? 0 : 1, null)
          })
          return terminator
        })
        const controller = new AbortController()
        let terminated = false
        let settled = false
        const pending =
          kind === 'filesystem'
            ? removeLocalWorktreePath(
                String.raw`C:\repo\feature`,
                { wslDistro: DISTRO },
                controller.signal
              )
            : removeWorktree(String.raw`C:\repo`, String.raw`C:\repo\feature`, false, {
                wslDistro: DISTRO,
                deleteBranch: false,
                knownRemovedWorktree: { branch: 'feature', head: 'abc' },
                checkoutDeleteSignal: controller.signal,
                observeChildTermination: (ended) => {
                  void ended.then(() => {
                    terminated = true
                  })
                }
              })
        const outcome = pending.then(
          () => {
            settled = true
          },
          (error: unknown) => {
            settled = true
            return error
          }
        )
        try {
          await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1))
          await Promise.resolve()
          controller.abort()
          await vi.advanceTimersByTimeAsync(15_000)
          if (confirmed) {
            expect(await outcome).toMatchObject({ name: 'AbortError' })
            if (kind === 'git') {
              expect(terminated).toBe(true)
            }
            expect(settled).toBe(true)
          } else {
            expect(terminated).toBe(false)
            expect(settled).toBe(false)
            expect(command.kill).toHaveBeenCalled()
            // Release the fixture's held owner with independent guest proof, never shim closure.
            guestConfirmed = true
            if (!barrier) {
              throw new Error('guest barrier missing')
            }
            await barrier.force(command)
            expect(await outcome).toMatchObject({ name: 'AbortError' })
          }
          expect(spawnMock.mock.calls[0]?.[1]?.join(' ')).toContain('setsid --wait')
        } finally {
          processSeam.mockRestore()
          vi.useRealTimers()
        }
      })
    }
  )

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
