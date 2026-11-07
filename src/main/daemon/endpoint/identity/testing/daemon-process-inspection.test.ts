import { describe, expect, it, vi } from 'vitest'
import type * as WindowsProcessTableModule from '../../../../windows/windows-process-table'
import {
  mergeProcessLivenessVerdict,
  queryWindowsProcess,
  readLinuxProcessStartedAtMs,
  readProcessCommandLine
} from '../daemon-process-inspection'

const { readWindowsProcessCreationTime } = vi.hoisted(() => ({
  readWindowsProcessCreationTime: vi.fn((_pid: number): number | null => null)
}))
vi.mock('../../../../windows/windows-process-table', async (importOriginal) => ({
  ...(await importOriginal<typeof WindowsProcessTableModule>()),
  readWindowsProcessCreationTime
}))

// btime 1699000000 with 1000 start ticks: 10s after boot at 100Hz, 1s at 1000Hz.
const readProcStat = async (path: string): Promise<string> =>
  path === '/proc/stat' ? 'btime 1699000000\n' : `42 (orca-daemon) S${' 0'.repeat(18)} 1000 0 0\n`

describe('daemon process inspection', () => {
  it('falls back to ps when Linux procfs returns an empty command line', async () => {
    const readTextFile = vi.fn(async () => '')
    const runCommand = vi.fn(async () => 'node daemon-entry --socket daemon.sock')

    await expect(readProcessCommandLine(42, 'linux', { readTextFile, runCommand })).resolves.toBe(
      'node daemon-entry --socket daemon.sock'
    )
    expect(readTextFile).toHaveBeenCalledWith('/proc/42/cmdline')
    expect(runCommand).toHaveBeenCalledWith('ps', ['-p', '42', '-o', 'command='], 2_000)
  })

  it('reads the Windows process from the process table, not a PowerShell spawn', async () => {
    const runCommand = vi.fn()
    const readProcessTable = vi.fn(async () => [
      { pid: 42, ppid: 1, name: 'node.exe', command: 'daemon', creationTimeMs: 7 }
    ])

    await expect(queryWindowsProcess(42, { runCommand, readProcessTable })).resolves.toEqual({
      status: 'present',
      commandLine: 'daemon',
      startedAtMs: 7
    })
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('falls back to the single-PID creation time when the snapshot row has none', async () => {
    readWindowsProcessCreationTime.mockReturnValueOnce(9)
    const readProcessTable = vi.fn(async () => [
      { pid: 42, ppid: 1, name: 'node.exe', command: 'daemon' }
    ])

    await expect(queryWindowsProcess(42, { readProcessTable })).resolves.toEqual({
      status: 'present',
      commandLine: 'daemon',
      startedAtMs: 9
    })
    expect(readWindowsProcessCreationTime).toHaveBeenCalledWith(42)
  })

  it('keeps an unreadable process table indeterminate instead of proving the process gone', async () => {
    const readProcessTable = vi.fn(async () => {
      throw new Error('windows process table is unreadable')
    })

    await expect(queryWindowsProcess(42, { readProcessTable })).resolves.toEqual({
      status: 'unavailable'
    })
  })

  it('reports absence only from a table that was read and lacks the PID', async () => {
    const readProcessTable = vi.fn(async () => [
      { pid: 7, ppid: 1, name: 'other.exe', command: '' }
    ])

    await expect(queryWindowsProcess(42, { readProcessTable })).resolves.toEqual({
      status: 'missing'
    })
  })

  // Keep each host runner's CLK_TCK cache isolated.
  it('scopes the CLK_TCK cache to the runner that produced it', async () => {
    const hundredHz = vi.fn(async () => '100')
    const thousandHz = vi.fn(async () => '1000')

    await expect(
      readLinuxProcessStartedAtMs(42, { readTextFile: readProcStat, runCommand: hundredHz })
    ).resolves.toBe(1_699_000_010_000)
    await expect(
      readLinuxProcessStartedAtMs(42, { readTextFile: readProcStat, runCommand: thousandHz })
    ).resolves.toBe(1_699_000_001_000)
    expect(thousandHz).toHaveBeenCalledWith('getconf', ['CLK_TCK'], 1_000)

    await expect(
      readLinuxProcessStartedAtMs(42, { readTextFile: readProcStat, runCommand: hundredHz })
    ).resolves.toBe(1_699_000_010_000)
    expect(hundredHz).toHaveBeenCalledOnce()
  })

  it('retries getconf for a runner whose first CLK_TCK read failed', async () => {
    let attempt = 0
    const runCommand = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) {
        throw new Error('getconf missing')
      }
      return '100'
    })

    await expect(
      readLinuxProcessStartedAtMs(42, { readTextFile: readProcStat, runCommand })
    ).resolves.toBeNull()
    await expect(
      readLinuxProcessStartedAtMs(42, { readTextFile: readProcStat, runCommand })
    ).resolves.toBe(1_699_000_010_000)
  })

  // Host pruning must prefer live over unverifiable over exited, regardless of protocol-record order.
  describe('mergeProcessLivenessVerdict', () => {
    const unverifiable = { status: 'unverifiable', reason: 'probe failed' } as const

    it('keeps a live verdict when a later record for the same version reports exited', () => {
      expect(mergeProcessLivenessVerdict({ status: 'live' }, { status: 'exited' })).toEqual({
        status: 'live'
      })
    })

    it('keeps a live verdict when a later record reports unverifiable', () => {
      expect(mergeProcessLivenessVerdict({ status: 'live' }, unverifiable)).toEqual({
        status: 'live'
      })
    })

    it('never lets an exited record downgrade an unverifiable verdict', () => {
      expect(mergeProcessLivenessVerdict(unverifiable, { status: 'exited' })).toEqual(unverifiable)
    })

    it('lets a live record supersede an earlier exited or unverifiable verdict', () => {
      expect(mergeProcessLivenessVerdict({ status: 'exited' }, { status: 'live' })).toEqual({
        status: 'live'
      })
      expect(mergeProcessLivenessVerdict(unverifiable, { status: 'live' })).toEqual({
        status: 'live'
      })
    })

    it('lets an unverifiable record upgrade an earlier exited verdict', () => {
      expect(mergeProcessLivenessVerdict({ status: 'exited' }, unverifiable)).toEqual(unverifiable)
    })
  })
})
