import { describe, expect, it, vi } from 'vitest'
import {
  mergeProcessLivenessVerdict,
  queryWindowsProcess,
  readLinuxProcessStartedAtMs,
  readMacosProcessStartedAtMs,
  readProcessCommandLine
} from './daemon-process-inspection'

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

  it('uses a non-empty Linux procfs command line without spawning ps', async () => {
    const readTextFile = vi.fn(async () => 'node\0daemon-entry')
    const runCommand = vi.fn()

    await expect(readProcessCommandLine(42, 'linux', { readTextFile, runCommand })).resolves.toBe(
      'node\0daemon-entry'
    )
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('asks PowerShell to report a failed CIM query instead of an absent process', async () => {
    const runCommand = vi.fn(
      async (_file: string, _args: string[], _timeoutMs: number) =>
        '{"status":"present","cmd":"daemon","start":1}'
    )

    await queryWindowsProcess(42, { runCommand })

    const script = runCommand.mock.calls[0]?.[1].at(-1) ?? ''
    expect(script).toContain("$ErrorActionPreference = 'Stop'")
    expect(script).toMatch(/catch \{[^}]*query_failed/)
  })

  it('keeps a failed CIM query indeterminate instead of proving the process gone', async () => {
    const runCommand = vi.fn(async () => '{"status":"query_failed"}')

    await expect(queryWindowsProcess(42, { runCommand })).resolves.toEqual({
      status: 'unavailable'
    })
  })

  it('never reads a probe result without a success marker as proof of absence', async () => {
    const runCommand = vi.fn(async () => '{"exists":false}')

    await expect(queryWindowsProcess(42, { runCommand })).resolves.toEqual({
      status: 'unavailable'
    })
  })

  it('reports absence only from a CIM query that ran and found nothing', async () => {
    const runCommand = vi.fn(async () => '{"status":"missing"}')

    await expect(queryWindowsProcess(42, { runCommand })).resolves.toEqual({ status: 'missing' })
  })

  it('reads the macOS start time through an async spawn', async () => {
    const runCommand = vi.fn(async () => 'Sat Jan  1 00:00:00 2028\n')

    await expect(readMacosProcessStartedAtMs(42, { runCommand })).resolves.toBe(
      Date.parse('Sat Jan  1 00:00:00 2028')
    )
    expect(runCommand).toHaveBeenCalledWith('ps', ['-p', '42', '-o', 'lstart='], 2_000)
  })

  // CLK_TCK belongs to the host that runs getconf, so a second runner must not inherit the first's.
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

    // The first runner stays cached: one spawn per runner, not per call.
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

  // Several daemon-v<N>.pid records can name the same app version; the merged verdict decides
  // whether pruneOldDaemonHosts may delete that version's host dir, so a wrong winner deletes a
  // live host. Precedence: live > unverifiable > exited, regardless of record order.
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

    it('adopts the first verdict when there is no prior one', () => {
      expect(mergeProcessLivenessVerdict(undefined, { status: 'exited' })).toEqual({
        status: 'exited'
      })
    })
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    'rejects unsafe Windows pid %s before command interpolation',
    async (pid) => {
      const runCommand = vi.fn()

      await expect(queryWindowsProcess(pid, { runCommand })).resolves.toEqual({
        status: 'unavailable'
      })
      expect(runCommand).not.toHaveBeenCalled()
    }
  )
})
