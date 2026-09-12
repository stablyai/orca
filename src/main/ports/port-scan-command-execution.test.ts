import { afterEach, describe, expect, it, vi } from 'vitest'
import { runPortScanCommandInProcess } from './port-scan-command-execution'
import {
  PORT_SCAN_COMMAND_TIMEOUT_MS,
  PortScanCommandTimeoutError,
  WATCHDOG_GRACE_MS
} from './port-scan-command-protocol'

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('child_process', () => ({
  execFile: execFileMock
}))

// Why (#11161): must outlast the whole watchdog budget, otherwise a watchdog
// armed before execFile still survives the stall and the ordering goes unpinned.
const SPAWN_STALL_MS = PORT_SCAN_COMMAND_TIMEOUT_MS + WATCHDOG_GRACE_MS + 200
const LSOF_OUTPUT = ['p123', 'cnode', 'n127.0.0.1:5173'].join('\n')

/** Emulates a hooked CreateProcessW: blocks the calling thread inside uv_spawn. */
function blockCallingThread(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

describe('runPortScanCommandInProcess', () => {
  afterEach(() => {
    vi.useRealTimers()
    execFileMock.mockReset()
  })

  it('arms the watchdog only after process creation returns', async () => {
    execFileMock.mockImplementation(
      (_command: string, _args: string[], _options: unknown, callback: unknown) => {
        blockCallingThread(SPAWN_STALL_MS)
        // The command itself is healthy once it finally starts.
        setTimeout(() => (callback as (e: null, out: string) => void)(null, LSOF_OUTPUT), 5)
        return { kill: vi.fn() }
      }
    )

    const result = await runPortScanCommandInProcess('lsof', ['-nP', '-iTCP'])

    expect(result.stdout).toBe(LSOF_OUTPUT)
    expect(result.spawnMs).toBeGreaterThanOrEqual(SPAWN_STALL_MS - 100)
    // Why the explicit budget: the stall is deliberately longer than the whole
    // watchdog budget (5.2s), so on vitest's 5s default this test could never
    // pass -- it has been red since #12217 landed.
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

  it("classifies Node's own execFile timeout kill as a command timeout", async () => {
    execFileMock.mockImplementation(
      (_command: string, _args: string[], _options: unknown, callback: unknown) => {
        const killed = Object.assign(new Error('Command failed: lsof'), {
          killed: true,
          signal: 'SIGTERM'
        })
        setTimeout(() => (callback as (e: Error) => void)(killed), 0)
        return { kill: vi.fn() }
      }
    )

    await expect(runPortScanCommandInProcess('lsof', [])).rejects.toBeInstanceOf(
      PortScanCommandTimeoutError
    )
  })

  it('leaves a genuine command failure unclassified so the scan does not back off', async () => {
    execFileMock.mockImplementation(
      (_command: string, _args: string[], _options: unknown, callback: unknown) => {
        setTimeout(() => (callback as (e: Error) => void)(new Error('spawn ENOENT')), 0)
        return { kill: vi.fn() }
      }
    )

    const error = await runPortScanCommandInProcess('lsof', []).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(PortScanCommandTimeoutError)
  })
})
