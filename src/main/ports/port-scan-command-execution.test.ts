import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import { runPortScanCommandInProcess } from './port-scan-command-execution'
import {
  PORT_SCAN_COMMAND_TIMEOUT_MS,
  PortScanCommandTimeoutError,
  WATCHDOG_GRACE_MS
} from './port-scan-command-protocol'

const { execFileMock, statfsMock, lstatMock, mkdirMock, openMock, spawnMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  statfsMock: vi.fn(),
  lstatMock: vi.fn(),
  mkdirMock: vi.fn(),
  openMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: execFileMock
}))
vi.mock('@orca/process-host', () => ({ spawnProcess: spawnMock }))
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFs>()),
  statfsSync: statfsMock,
  lstatSync: lstatMock,
  mkdirSync: mkdirMock,
  openSync: openMock
}))

// Exceed the whole watchdog budget so arming it before uv_spawn would fail (#11161).
const SPAWN_STALL_MS = PORT_SCAN_COMMAND_TIMEOUT_MS + WATCHDOG_GRACE_MS + 200
const LSOF_OUTPUT = ['p123', 'cnode', 'n127.0.0.1:5173'].join('\n')

function blockCallingThread(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

describe('runPortScanCommandInProcess', () => {
  afterEach(() => {
    vi.useRealTimers()
    execFileMock.mockReset()
    vi.resetAllMocks()
    vi.unstubAllGlobals()
  })

  function darwinFilesystem(type: number): void {
    vi.stubGlobal(
      'process',
      Object.create(process, { platform: { value: 'darwin' }, getuid: { value: () => 501 } })
    )
    statfsMock.mockReturnValue({ type })
    lstatMock.mockImplementation((path: string) => ({
      isDirectory: () => true,
      uid: path === '/private/var/tmp' ? 0 : 501,
      mode: path === '/private/var/tmp' ? 0o41777 : 0o40700,
      dev: 1
    }))
  }

  it('does not turn supported-filesystem contention or unsafe storage into unlocked scanning', async () => {
    darwinFilesystem(0x1a)
    openMock.mockImplementation(() => {
      throw new Error('EAGAIN')
    })
    await expect(runPortScanCommandInProcess('/usr/sbin/lsof', [], 'attribution')).rejects.toThrow(
      'EAGAIN'
    )
    lstatMock.mockReturnValue({ isDirectory: () => false })
    await expect(runPortScanCommandInProcess('/usr/sbin/lsof', [], 'attribution')).rejects.toThrow(
      'storage is unavailable'
    )
    expect(execFileMock).not.toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('arms the watchdog only after process creation returns', async () => {
    execFileMock.mockImplementation(
      (_command: string, _args: string[], _options: unknown, callback: unknown) => {
        blockCallingThread(SPAWN_STALL_MS)
        setTimeout(() => (callback as (e: null, out: string) => void)(null, LSOF_OUTPUT), 5)
        return { kill: vi.fn() }
      }
    )

    const result = await runPortScanCommandInProcess('lsof', ['-nP', '-iTCP'])

    expect(result.stdout).toBe(LSOF_OUTPUT)
    expect(result.spawnMs).toBeGreaterThanOrEqual(SPAWN_STALL_MS - 100)
    // The deliberate >5s stall requires a longer test deadline.
  }, 15_000)

  it('kills the child and times out when the callback never arrives', async () => {
    vi.useFakeTimers()
    const killMock = vi.fn()
    execFileMock.mockImplementation(() => ({ kill: killMock }))

    let settled = false
    const promise = runPortScanCommandInProcess('lsof', []).catch((error: unknown) => {
      settled = true
      return error
    })

    await vi.advanceTimersByTimeAsync(PORT_SCAN_COMMAND_TIMEOUT_MS)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(WATCHDOG_GRACE_MS)

    expect(await promise).toBeInstanceOf(PortScanCommandTimeoutError)
    expect(killMock).toHaveBeenCalled()
  })
})
