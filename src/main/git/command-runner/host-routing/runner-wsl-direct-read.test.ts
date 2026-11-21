import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeSpawnedChild } from '../../../../shared/__fixtures__/fake-spawned-child'
import type * as WorkerChildProcessModule from '../../../worker-thread-child-process/worker-thread-child-process'

const { execFileMock, execFileSyncMock, spawnMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  spawnMock: vi.fn()
}))

// These tests drive the in-thread spawn mocks; keep Windows launches off the real process worker.
vi.mock(
  '../../../worker-thread-child-process/worker-thread-child-process',
  async (importOriginal) => ({
    ...(await importOriginal<typeof WorkerChildProcessModule>()),
    canSpawnOnWorkerThread: () => false,
    whenSpawnWorkerReady: async () => false
  })
)

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
  spawn: spawnMock
}))
vi.mock('../../../observability/instrumentation', () => ({
  withGitSpan: (_attributes: unknown, run: () => unknown) => run()
}))
vi.mock('../../../diagnostics/main-thread-churn-probe', () => ({ recordSubprocessSpawn: vi.fn() }))
// The distro's mount root counts as already read, so spawns here are the Git commands under test.
vi.mock('../../../wsl/filesystem/wsl-automount-root', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  settleWslAutomountRoot: () => null
}))
import { gitExecFileAsync, gitExecFileAsyncBuffer } from '../git-exec-file'

import { _resetGitAdmissionForTests } from '../admission/git-subprocess-admission'

import {
  recordHostAutocrlf,
  resetWslWindowsCheckoutGitConfigForTests,
  wslWindowsCheckoutKey
} from './wsl-windows-checkout-git-config'
import {
  resetWslGitReadEnvironmentForTests,
  seedWslGitReadEnvironmentForTests
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
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000)
    execFileMock.mockReset()
    execFileSyncMock.mockReset()
    spawnMock.mockReset()
    resetWslGitReadEnvironmentForTests()
    resetWslLinkedWorktreeGitRoutingForTests()
    resetWslWindowsCheckoutGitConfigForTests()
    recordHostAutocrlf(wslWindowsCheckoutKey(String.raw`C:\repo`, DISTRO), 'other', Date.now())
  })

  afterEach(() => {
    vi.useRealTimers()
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
