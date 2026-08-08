import type * as ChildProcessModule from 'node:child_process'
import type * as FsPromisesModule from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import type { ExactDaemonIncarnation } from './daemon-incarnation-evidence-types'

const LINUX_BOOT_TIME_SECONDS = 1_699_000_000
const LINUX_START_TICKS = 1_234
const LINUX_CLOCK_TICKS_PER_SECOND = 100

const { execFileMock, execFileSyncMock, readFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(
    (
      file: string,
      _args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, result: { stdout: string; stderr: string }) => void
    ) => {
      callback(null, {
        stdout: file === 'getconf' ? '100\n' : `${new Date(1_700_000_000_000).toString()}\n`,
        stderr: ''
      })
    }
  ),
  execFileSyncMock: vi.fn(() => ''),
  readFileMock: vi.fn(async (path: string) =>
    path === '/proc/stat' ? 'btime 1699000000\n' : `42 (orca-daemon) S${' 0'.repeat(18)} 1234 0 0\n`
  )
}))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessModule>()),
  execFile: execFileMock,
  execFileSync: execFileSyncMock
}))

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromisesModule>()),
  readFile: readFileMock
}))

const { probeDaemonProcessIdentity } = await import('./daemon-incarnation-evidence')

const endpoint = { socketPath: '/runtime/daemon.sock', tokenPath: '/runtime/daemon.token' }
const exactIncarnation: ExactDaemonIncarnation = {
  identity: { pid: 42, startedAtMs: 1_700_000_000_000, launchNonce: 'launch-a' }
}
const daemonCommandLine = `node daemon-entry --socket ${endpoint.socketPath} --token ${endpoint.tokenPath}`

describe('daemon audit evidence main-thread cost', () => {
  it('reads the macOS process start time without a synchronous main-thread spawn', async () => {
    await expect(
      probeDaemonProcessIdentity(exactIncarnation, endpoint, {
        platform: 'darwin',
        signalProcess: () => 'occupied',
        readCommandLine: async () => daemonCommandLine
      })
    ).resolves.toMatchObject({ state: 'present', reason: 'macos_identity_match' })

    expect(execFileSyncMock).not.toHaveBeenCalled()
    expect(execFileMock).toHaveBeenCalledWith(
      'ps',
      ['-p', '42', '-o', 'lstart='],
      expect.anything(),
      expect.any(Function)
    )
  })

  // Legacy bare-integer pid files carry no start ticks, so linux falls back to the start time.
  it('reads the linux process start time without a synchronous main-thread spawn', async () => {
    const startedAtMs =
      LINUX_BOOT_TIME_SECONDS * 1000 + (LINUX_START_TICKS / LINUX_CLOCK_TICKS_PER_SECOND) * 1000

    await expect(
      probeDaemonProcessIdentity(
        { identity: { pid: 42, startedAtMs, launchNonce: 'launch-a' } },
        endpoint,
        {
          platform: 'linux',
          signalProcess: () => 'occupied',
          readLinuxStat: async () => ({ status: 'present', value: '42 (orca-daemon) S 1' }),
          readCommandLine: async () => daemonCommandLine
        }
      )
    ).resolves.toMatchObject({ state: 'present', reason: 'linux_identity_match' })

    expect(execFileSyncMock).not.toHaveBeenCalled()
    expect(execFileMock).toHaveBeenCalledWith(
      'getconf',
      ['CLK_TCK'],
      expect.anything(),
      expect.any(Function)
    )
  })
})
