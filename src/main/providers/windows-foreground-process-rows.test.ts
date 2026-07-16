// Regression guard: the Windows agent foreground-process scan re-forks
// powershell.exe (or the wmic fallback) on a ~1s/pane cadence. Electron's main
// process has no console, so a spawn without windowsHide pops a fresh conhost
// window per scan that flashes and steals keyboard focus from the foreground app
// (including Orca's own terminal). Both probes MUST pass windowsHide: true.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'

const { execFileMock, performanceNowMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  performanceNowMock: vi.fn(() => 1_000)
}))

vi.mock('child_process', () => ({ execFile: execFileMock }))
vi.mock('node:perf_hooks', () => ({ performance: { now: performanceNowMock } }))

import {
  queryWindowsProcessDescendants,
  queryWindowsProcessRows,
  resetWindowsProcessRowsSnapshotForTests
} from './windows-foreground-process-rows'

type ExecFileCallback = (err: unknown, result: { stdout: string; stderr: string }) => void
type ExecFileCall = [string, string[], Record<string, unknown>, ExecFileCallback]

const POWERSHELL_ROWS_JSON = JSON.stringify([
  {
    ProcessId: 100,
    ParentProcessId: 50,
    Name: 'powershell.exe',
    CommandLine: 'powershell.exe',
    ExecutablePath: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    CreationDate: '1000',
    KernelModeTime: '0',
    UserModeTime: '0',
    WorkingSetSize: '4096'
  },
  {
    ProcessId: 200,
    ParentProcessId: 100,
    Name: 'node.exe',
    CommandLine: 'node C:/Users/dev/AppData/codex/bin/codex.js',
    ExecutablePath: 'C:/Program Files/nodejs/node.exe',
    CreationDate: '2000',
    KernelModeTime: '0',
    UserModeTime: '0',
    WorkingSetSize: '8192'
  }
])

const WMIC_ROWS_VALUE =
  'CommandLine=powershell.exe\n' +
  'CreationDate=20260716000000.000000-000\n' +
  'ExecutablePath=C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe\n' +
  'KernelModeTime=0\n' +
  'Name=powershell.exe\n' +
  'ParentProcessId=50\n' +
  'ProcessId=100\n' +
  'UserModeTime=0\n' +
  'WorkingSetSize=4096\n\n' +
  'CommandLine=node C:/Users/dev/AppData/codex/bin/codex.js\n' +
  'CreationDate=20260716000001.000000-000\n' +
  'ExecutablePath=C:/Program Files/nodejs/node.exe\n' +
  'KernelModeTime=0\n' +
  'Name=node.exe\n' +
  'ParentProcessId=100\n' +
  'ProcessId=200\n' +
  'UserModeTime=0\n' +
  'WorkingSetSize=8192\n'

type MetricRowOverrides = Partial<{
  CreationDate: string
  KernelModeTime: string
  UserModeTime: string
  WorkingSetSize: string
}>

function metricRowsJson(overrides: MetricRowOverrides = {}): string {
  return JSON.stringify({
    ProcessId: 100,
    ParentProcessId: 50,
    Name: 'node.exe',
    CommandLine: 'node agent.js',
    ExecutablePath: 'C:/Program Files/nodejs/node.exe',
    CreationDate: '1000',
    KernelModeTime: '0',
    UserModeTime: '0',
    WorkingSetSize: '4096',
    ...overrides
  })
}

function mockPowerShellRows(outputs: string[]): void {
  const remaining = [...outputs]
  execFileMock.mockImplementation((_cmd: string, _args, _opts, cb: ExecFileCallback) => {
    const stdout = remaining.shift()
    if (stdout === undefined) {
      cb(new Error('unexpected process scan'), { stdout: '', stderr: '' })
      return
    }
    cb(null, { stdout, stderr: '' })
  })
}

/** Returns the options object passed to the mocked execFile for a given command. */
function optionsForCommand(command: string): Record<string, unknown> | undefined {
  const call = execFileMock.mock.calls.find((args) => (args as ExecFileCall)[0] === command) as
    | ExecFileCall
    | undefined
  return call?.[2]
}

describe('windows foreground process rows spawn options', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    execFileMock.mockReset()
    performanceNowMock.mockReset()
    performanceNowMock.mockReturnValue(1_000)
    resetWindowsProcessRowsSnapshotForTests()
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })

  afterEach(() => {
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('hides the console window for the powershell process-table scan', async () => {
    execFileMock.mockImplementation((_cmd: string, _args, _opts, cb: ExecFileCallback) => {
      cb(null, { stdout: POWERSHELL_ROWS_JSON, stderr: '' })
    })

    const candidates = await queryWindowsProcessDescendants(100)

    expect(candidates?.[0]?.pid).toBe(200)
    expect(optionsForCommand('powershell.exe')).toMatchObject({ windowsHide: true })
  })

  it('hides the console window for the wmic fallback scan', async () => {
    execFileMock.mockImplementation((cmd: string, _args, _opts, cb: ExecFileCallback) => {
      // Force the powershell probe to miss so the wmic fallback runs.
      if (cmd === 'powershell.exe') {
        cb(new Error('powershell unavailable'), { stdout: '', stderr: '' })
        return
      }
      cb(null, { stdout: WMIC_ROWS_VALUE, stderr: '' })
    })

    const candidates = await queryWindowsProcessDescendants(100)

    expect(candidates?.[0]?.pid).toBe(200)
    expect(candidates?.[0]?.memory).toBe(8192)
    expect(optionsForCommand('wmic')).toMatchObject({ windowsHide: true })
  })
})

describe('windows process resource rows', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    performanceNowMock.mockReset()
    performanceNowMock.mockReturnValue(1_000)
    resetWindowsProcessRowsSnapshotForTests()
  })

  it('reports working-set memory immediately and warms CPU on the first scan', async () => {
    mockPowerShellRows([metricRowsJson({ WorkingSetSize: '5242880' })])

    const rows = await queryWindowsProcessRows()

    expect(rows).toMatchObject([{ pid: 100, cpu: 0, memory: 5_242_880 }])
  })

  it('computes percent-of-one-core CPU from the second actual scan', async () => {
    mockPowerShellRows([
      metricRowsJson({ KernelModeTime: '1000000' }),
      metricRowsJson({ KernelModeTime: '11000000' })
    ])
    performanceNowMock.mockReturnValueOnce(1_000).mockReturnValueOnce(2_000)

    await queryWindowsProcessRows()
    const second = await queryWindowsProcessRows({ fresh: true })

    expect(second?.[0].cpu).toBe(100)
  })

  it('reuses the cached rows without spawning or resampling CPU', async () => {
    mockPowerShellRows([metricRowsJson({ KernelModeTime: '1000000' })])

    const first = await queryWindowsProcessRows()
    const cached = await queryWindowsProcessRows()

    expect(cached).toBe(first)
    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(performanceNowMock).toHaveBeenCalledTimes(1)
  })

  it('warms up again when a PID has a new creation identity', async () => {
    mockPowerShellRows([
      metricRowsJson({ CreationDate: 'first', KernelModeTime: '1000000' }),
      metricRowsJson({ CreationDate: 'reused', KernelModeTime: '21000000' })
    ])
    performanceNowMock.mockReturnValueOnce(1_000).mockReturnValueOnce(2_000)

    await queryWindowsProcessRows()
    const reused = await queryWindowsProcessRows({ fresh: true })

    expect(reused?.[0].cpu).toBe(0)
  })

  it('warms up again when cumulative CPU counters regress', async () => {
    mockPowerShellRows([
      metricRowsJson({ KernelModeTime: '21000000' }),
      metricRowsJson({ KernelModeTime: '1000000' })
    ])
    performanceNowMock.mockReturnValueOnce(1_000).mockReturnValueOnce(1_100)

    await queryWindowsProcessRows()
    const regressed = await queryWindowsProcessRows({ fresh: true })

    expect(regressed?.[0].cpu).toBe(0)
  })

  it('keeps the earlier baseline across a too-short forced scan', async () => {
    mockPowerShellRows([
      metricRowsJson({ KernelModeTime: '0' }),
      metricRowsJson({ KernelModeTime: '10000000' }),
      metricRowsJson({ KernelModeTime: '20000000' })
    ])
    performanceNowMock
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_100)
      .mockReturnValueOnce(2_000)

    await queryWindowsProcessRows()
    const tooSoon = await queryWindowsProcessRows({ fresh: true })
    const settled = await queryWindowsProcessRows({ fresh: true })

    expect(tooSoon?.[0].cpu).toBe(0)
    expect(settled?.[0].cpu).toBe(200)
  })

  it('warms up again after a stale sampling gap', async () => {
    mockPowerShellRows([
      metricRowsJson({ KernelModeTime: '0' }),
      metricRowsJson({ KernelModeTime: '100000000' })
    ])
    performanceNowMock.mockReturnValueOnce(1_000).mockReturnValueOnce(12_000)

    await queryWindowsProcessRows()
    const stale = await queryWindowsProcessRows({ fresh: true })

    expect(stale?.[0].cpu).toBe(0)
  })

  it('does not sample CPU without a creation identity or complete counters', async () => {
    mockPowerShellRows([
      metricRowsJson({ CreationDate: '', KernelModeTime: '0' }),
      metricRowsJson({ CreationDate: '', KernelModeTime: '10000000' }),
      JSON.stringify({ ProcessId: 200, ParentProcessId: 100, Name: 'child.exe' })
    ])
    performanceNowMock
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(2_000)
      .mockReturnValueOnce(3_000)

    await queryWindowsProcessRows()
    const missingIdentity = await queryWindowsProcessRows({ fresh: true })
    const missingFields = await queryWindowsProcessRows({ fresh: true })

    expect(missingIdentity?.[0].cpu).toBe(0)
    expect(missingFields).toMatchObject([{ pid: 200, cpu: 0, memory: 0 }])
  })

  it('bounds impossible CPU deltas to the logical-core ceiling', async () => {
    mockPowerShellRows([
      metricRowsJson({ KernelModeTime: '0' }),
      metricRowsJson({ KernelModeTime: '999999999999' })
    ])
    performanceNowMock.mockReturnValueOnce(1_000).mockReturnValueOnce(2_000)

    await queryWindowsProcessRows()
    const bounded = await queryWindowsProcessRows({ fresh: true })

    expect(bounded?.[0].cpu).toBe(Math.max(1, os.cpus().length) * 100)
  })

  it('returns null when both PowerShell and WMIC enumeration are unavailable', async () => {
    execFileMock.mockImplementation((_cmd: string, _args, _opts, cb: ExecFileCallback) => {
      cb(new Error('unavailable'), { stdout: '', stderr: '' })
    })

    await expect(queryWindowsProcessRows()).resolves.toBeNull()
    expect(execFileMock).toHaveBeenCalledTimes(2)
  })
})
