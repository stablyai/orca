import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runProcessMock = vi.fn()
vi.mock('../shared/child-process/run-process', () => ({
  runProcess: (spec: unknown) => runProcessMock(spec)
}))

vi.mock('./relay-command-env', () => ({
  buildRelayCommandEnv: () => ({ PATH: 'C:\\Windows\\System32' })
}))

import {
  __setWindowsProcessTableCimScanForTests,
  __setWindowsProcessTreeLoaderForTests,
  resetWindowsProcessTableForTests
} from '../main/windows/windows-process-table'
import {
  resetWindowsPortScanDiagnosticsForTests,
  scanWindowsListeningPorts
} from './windows-port-scan'

type Spec = {
  program: string
  args?: readonly string[]
  timeoutMs?: number | null
  signal?: AbortSignal
}

// The scanner drops any row whose pid is the relay process or its parent, so a fixture pid
// that happens to match the vitest worker's own pid silently empties the result and the
// assertion sees []. Shift off the literals only on collision, which keeps the readable
// 1234/2468 in the normal case while staying hermetic.
const SELF_PIDS = new Set([process.pid, process.ppid])

function pidUnlikeSelf(seed: number): number {
  let pid = seed
  while (SELF_PIDS.has(pid)) {
    pid += 1
  }
  return pid
}

const NETSTAT_PID = pidUnlikeSelf(2468)
const SSHD_PID = pidUnlikeSelf(4321)
const POWERSHELL_PID = pidUnlikeSelf(1234)

const NETSTAT_STDOUT = [
  '  Proto  Local Address          Foreign Address        State           PID',
  `  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       ${NETSTAT_PID}`,
  `  TCP    [::]:3000              [::]:0                 LISTENING       ${NETSTAT_PID}`,
  `  TCP    0.0.0.0:4000           93.184.216.34:443      ESTABLISHED     ${NETSTAT_PID}`,
  `  UDP    0.0.0.0:5353           *:*                                    ${NETSTAT_PID}`,
  `  TCP    0.0.0.0:2222           0.0.0.0:0              LISTENING       ${SSHD_PID}`
].join('\r\n')

function ok(stdout: string): {
  code: number
  signal: null
  stdout: string
  stderr: string
  timedOut: boolean
} {
  return { code: 0, signal: null, stdout, stderr: '', timedOut: false }
}

type NativeRow = {
  pid: number
  ppid: number
  name: string
  memory?: number
  commandLine?: string
  creationTimeMs?: number
}

/** A native snapshot must contain the reader's own pid or the table rejects. */
function nativeTable(rows: NativeRow[]) {
  return () => ({
    ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2 },
    getAllProcesses: (callback: (processes: NativeRow[] | undefined) => void) =>
      callback([{ pid: process.pid, ppid: 0, name: 'vitest.exe' }, ...rows])
  })
}

function specs(): Spec[] {
  return runProcessMock.mock.calls.map((call) => call[0] as Spec)
}

describe('scanWindowsListeningPorts', () => {
  beforeEach(() => {
    runProcessMock.mockReset()
    resetWindowsPortScanDiagnosticsForTests()
    resetWindowsProcessTableForTests()
    __setWindowsProcessTreeLoaderForTests(
      nativeTable([
        { pid: NETSTAT_PID, ppid: 4, name: 'node.exe' },
        { pid: SSHD_PID, ppid: 4, name: 'sshd.exe' }
      ])
    )
  })

  afterEach(() => {
    __setWindowsProcessTreeLoaderForTests()
    __setWindowsProcessTableCimScanForTests()
    resetWindowsProcessTableForTests()
  })

  it('reads netstat first and never starts PowerShell', async () => {
    const controller = new AbortController()
    runProcessMock.mockResolvedValueOnce(ok(NETSTAT_STDOUT))

    await expect(scanWindowsListeningPorts(controller.signal)).resolves.toEqual([
      { host: '::', port: 3000, pid: NETSTAT_PID, processName: 'node' },
      { host: '0.0.0.0', port: 3000, pid: NETSTAT_PID, processName: 'node' }
    ])

    expect(specs()).toHaveLength(1)
    expect(specs()[0].program).toMatch(/netstat\.exe$/)
    // `-p tcp` is absent on purpose: on Windows it means IPv4-only and would
    // hide every `[::]` listener.
    expect(specs()[0].args).toEqual(['-ano'])
    expect(specs()[0].signal).toBe(controller.signal)
    expect(specs()[0].timeoutMs).toBe(5000)
  })

  it('keeps the sshd and self-pid filters working off native process names', async () => {
    runProcessMock.mockResolvedValueOnce(
      ok(
        [
          NETSTAT_STDOUT,
          `  TCP    0.0.0.0:9999           0.0.0.0:0              LISTENING       ${process.pid}`
        ].join('\r\n')
      )
    )

    const ports = await scanWindowsListeningPorts()

    // sshd.exe is matched despite the table's `.exe` spelling, and the relay's
    // own listener never reaches a client.
    expect(ports.map((port) => `${port.host}:${port.port}`)).toEqual([':::3000', '0.0.0.0:3000'])
  })

  it('still reports host/port/pid when no process table is readable', async () => {
    runProcessMock.mockResolvedValueOnce(ok(NETSTAT_STDOUT))
    __setWindowsProcessTreeLoaderForTests(() => null)
    __setWindowsProcessTableCimScanForTests(() =>
      Promise.reject(new Error('windows process table unavailable'))
    )
    resetWindowsProcessTableForTests()

    await expect(scanWindowsListeningPorts()).resolves.toEqual([
      { host: '0.0.0.0', port: 2222, pid: SSHD_PID },
      { host: '::', port: 3000, pid: NETSTAT_PID },
      { host: '0.0.0.0', port: 3000, pid: NETSTAT_PID }
    ])
    // Names were unavailable, so nothing else was spawned to go get them.
    expect(specs()).toHaveLength(1)
  })

  it('falls back to PowerShell without an execution-policy override', async () => {
    const controller = new AbortController()
    runProcessMock
      .mockResolvedValueOnce({
        code: 1,
        signal: null,
        stdout: '',
        stderr: 'blocked',
        timedOut: false
      })
      .mockResolvedValueOnce(
        ok(
          JSON.stringify({
            host: '127.0.0.1',
            port: 5173,
            pid: POWERSHELL_PID,
            processName: 'node'
          })
        )
      )

    await expect(scanWindowsListeningPorts(controller.signal)).resolves.toEqual([
      {
        host: '127.0.0.1',
        port: 5173,
        pid: POWERSHELL_PID,
        processName: 'node'
      }
    ])

    const powershell = specs()[1]
    expect(powershell.program).toMatch(/powershell\.exe$/i)
    expect(powershell.args?.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command'])
    expect(powershell.args).not.toContain('-ExecutionPolicy')
    expect(powershell.args).not.toContain('-EncodedCommand')
    expect(powershell.args).toHaveLength(4)
    expect(powershell.args?.[3]).toContain('Get-NetTCPConnection')
    expect(powershell.signal).toBe(controller.signal)
    expect(powershell.timeoutMs).toBe(5000)
  })

  it('tries pwsh when Windows PowerShell cannot answer, then gives up empty', async () => {
    runProcessMock
      .mockResolvedValueOnce(ok(''))
      .mockRejectedValueOnce(new Error('powershell unavailable'))
      .mockRejectedValueOnce(new Error('pwsh unavailable'))

    await expect(scanWindowsListeningPorts()).resolves.toEqual([])

    expect(specs().map((spec) => spec.program)).toEqual([
      expect.stringMatching(/netstat\.exe$/),
      expect.stringMatching(/powershell\.exe$/i),
      'pwsh.exe'
    ])
  })

  it('gives up rather than falling back once the scan is cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    runProcessMock.mockResolvedValueOnce({
      code: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false
    })

    await expect(scanWindowsListeningPorts(controller.signal)).resolves.toEqual([])

    expect(runProcessMock).toHaveBeenCalledTimes(1)
  })

  // `LISTENING` ships in netstat.exe.mui, picked by UI language, so no env can
  // pin it. Without the shape-based re-read a German host parses zero rows,
  // reads that as a blocked reader, and runs the flagged payload every 12-30s.
  it('reads a localized host by socket shape rather than the state word', async () => {
    runProcessMock.mockResolvedValueOnce(
      ok(
        [
          'Aktive Verbindungen',
          '',
          '  Proto  Lokale Adresse         Remoteadresse          Status           PID',
          '  TCP    0.0.0.0:135            0.0.0.0:0              ABHÖREN          1116',
          `  TCP    0.0.0.0:3000           0.0.0.0:0              ABHÖREN          ${NETSTAT_PID}`,
          `  TCP    [::]:3000              [::]:0                 ABHÖREN          ${NETSTAT_PID}`,
          `  TCP    192.168.0.5:52000      93.184.216.34:443      HERGESTELLT      ${NETSTAT_PID}`
        ].join('\r\n')
      )
    )

    await expect(scanWindowsListeningPorts()).resolves.toEqual([
      { host: '0.0.0.0', port: 135, pid: 1116 },
      { host: '::', port: 3000, pid: NETSTAT_PID, processName: 'node' },
      { host: '0.0.0.0', port: 3000, pid: NETSTAT_PID, processName: 'node' }
    ])
    expect(specs()).toHaveLength(1)
  })

  // The gap the state-word cases cannot cover: on a localized host BOUND is as
  // unreadable as ABHÖREN, so shape alone would publish 8080 as a listener.
  // Listeners dominate, and that is what separates them.
  it('drops a BOUND socket that shape alone would promote on a localized host', async () => {
    runProcessMock.mockResolvedValueOnce(
      ok(
        [
          `  TCP    0.0.0.0:3000           0.0.0.0:0              ABHÖREN          ${NETSTAT_PID}`,
          `  TCP    [::]:3000              [::]:0                 ABHÖREN          ${NETSTAT_PID}`,
          `  TCP    0.0.0.0:8080           0.0.0.0:0              GEBUNDEN         ${NETSTAT_PID}`,
          `  TCP    192.168.0.5:52000      93.184.216.34:443      HERGESTELLT      ${NETSTAT_PID}`
        ].join('\r\n')
      )
    )

    await expect(scanWindowsListeningPorts()).resolves.toEqual([
      { host: '::', port: 3000, pid: NETSTAT_PID, processName: 'node' },
      { host: '0.0.0.0', port: 3000, pid: NETSTAT_PID, processName: 'node' }
    ])
  })

  // Only on an exact tie does shape have nothing left to go on, and then it
  // keeps both rather than guessing — no worse than reading shape alone.
  it('keeps every tied zero-peer state when none dominates', async () => {
    runProcessMock.mockResolvedValueOnce(
      ok(
        [
          `  TCP    0.0.0.0:3000           0.0.0.0:0              ABHÖREN          ${NETSTAT_PID}`,
          `  TCP    0.0.0.0:8080           0.0.0.0:0              GEBUNDEN         ${NETSTAT_PID}`
        ].join('\r\n')
      )
    )

    await expect(scanWindowsListeningPorts()).resolves.toEqual([
      { host: '0.0.0.0', port: 3000, pid: NETSTAT_PID, processName: 'node' },
      { host: '0.0.0.0', port: 8080, pid: NETSTAT_PID, processName: 'node' }
    ])
  })

  // Windows prints BOUND with a zero peer too, so the shape test must stay the
  // fallback: a host with at least one readable LISTENING row never reaches it.
  it('does not promote a BOUND socket on a host whose state word parsed', async () => {
    runProcessMock.mockResolvedValueOnce(
      ok(
        [
          `  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       ${NETSTAT_PID}`,
          `  TCP    0.0.0.0:8080           0.0.0.0:0              BOUND           ${NETSTAT_PID}`
        ].join('\r\n')
      )
    )

    await expect(scanWindowsListeningPorts()).resolves.toEqual([
      { host: '0.0.0.0', port: 3000, pid: NETSTAT_PID, processName: 'node' }
    ])
  })

  // A capped read exits 0 and its head parses, and netstat orders IPv4 TCP
  // before IPv6 TCP, so publishing the head would drop every `[::]` listener.
  it('refuses a netstat table that hit the capture cap', async () => {
    const filler = Array.from(
      { length: 60_000 },
      (_, index) =>
        `  TCP    10.0.0.1:${1000 + (index % 5000)}      10.0.0.2:443           TIME_WAIT       4`
    ).join('\r\n')
    runProcessMock
      .mockResolvedValueOnce(ok(`${NETSTAT_STDOUT}\r\n${filler}`.slice(0, 4 * 1024 * 1024)))
      .mockResolvedValueOnce(ok('[]'))

    await expect(scanWindowsListeningPorts()).resolves.toEqual([])

    // Fell through instead of publishing the IPv4 head it could still parse.
    expect(specs()).toHaveLength(2)
    expect(specs()[1].args).toContain('-Command')
  })

  it('does not wait on the shared process table once the scan is cancelled', async () => {
    const controller = new AbortController()
    const getAllProcesses = vi.fn()
    __setWindowsProcessTreeLoaderForTests(() => ({
      ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2 },
      getAllProcesses
    }))
    resetWindowsProcessTableForTests()
    // netstat answered, then the request was abandoned before names were needed.
    runProcessMock.mockImplementationOnce(() => {
      controller.abort()
      return Promise.resolve(ok(NETSTAT_STDOUT))
    })

    await expect(scanWindowsListeningPorts(controller.signal)).resolves.toEqual([
      // Unnamed, so the sshd row survives its own filter — the cost of not
      // waiting, and strictly better than blocking an abandoned request.
      { host: '0.0.0.0', port: 2222, pid: SSHD_PID },
      { host: '::', port: 3000, pid: NETSTAT_PID },
      { host: '0.0.0.0', port: 3000, pid: NETSTAT_PID }
    ])
    expect(getAllProcesses).not.toHaveBeenCalled()
  })

  // The relay daemon's stderr is what installRelayLogRotation routes into
  // relay.log, so a fall-through logged anywhere else is a fall-through nobody
  // can diagnose. Pin the stream, not just the fact that something was called.
  it('reports leaving the native path on the relay diagnostic stream, once', async () => {
    const lines: string[] = []
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        lines.push(String(chunk))
        return true
      })
    try {
      runProcessMock.mockResolvedValue(ok(''))
      await scanWindowsListeningPorts()
      await scanWindowsListeningPorts()
      // A second, different fault on the same host must still be heard: one
      // flag for the whole module would have swallowed it.
      runProcessMock.mockResolvedValue(ok('x'.repeat(4 * 1024 * 1024)))
      await scanWindowsListeningPorts()
      await scanWindowsListeningPorts()
    } finally {
      stderr.mockRestore()
    }

    const reported = lines.filter((line) => line.includes('[ports] netstat unusable'))
    expect(reported).toHaveLength(2)
    expect(reported[0]).toContain('no listening row parsed')
    expect(reported[1]).toContain('truncated')
    // relayLogLine's ISO stamp: an unplaceable line cannot be read against the
    // reconnect flaps around it.
    expect(reported[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /)
  })

  it('treats a netstat timeout as unanswered and falls through', async () => {
    runProcessMock
      .mockResolvedValueOnce({
        code: null,
        signal: 'SIGKILL',
        stdout: '',
        stderr: '',
        timedOut: true
      })
      .mockResolvedValueOnce(ok('[]'))

    await expect(scanWindowsListeningPorts()).resolves.toEqual([])

    expect(specs()).toHaveLength(2)
  })
})
