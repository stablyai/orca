import type * as FsPromises from 'node:fs/promises'
import type { Session } from './session'
import type * as DarwinTerminalNames from '../../shared/darwin-terminal-names'
import type * as FullReader from '../../shared/process-table-snapshot-reader'
import {
  createProcessTablePsFixture,
  type PsFixtureRow
} from '../../shared/process-table-ps-test-fixture'
import type * as CheapReader from '../../shared/cheap-process-table-snapshot-reader'
import type * as TrackerModule from './pty-subprocess/foreground-process-tracker'
import type * as Inspection from './terminal-host-process-inspection'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// Measurement for the cheap-tier process inspection. Drives the REAL daemon inspection
// entrypoint (`inspectTerminalHostProcess`) for 8 idle agent panes over a simulated 60s idle
// cadence (POLL_TIER_INTERVAL_MS.idle = 2,000ms) and counts `ps` forks BY COLUMN SET: a fork
// asking for `command=` is the full capture (measured 0.34-0.50s on a 1,900-process Mac, 1.15s
// on Linux), one without it is the cheap capture (0.03s on both). CI cannot time a real `ps`
// portably, so fork counts by column set are what this test measures; the per-fork costs above
// are the numbers measured by hand on the reference hosts.
//
// The second test is the zero-trade-off proof: the same tick sequence, including an agent exit
// and a restart, produces the identical foregroundProcess series with the cheap tier on and off.

// Two seams because the two tiers spawn differently: the full evidence reader still forks
// through node:child_process, the cheap reader through Orca's runProcess entry point.
const { execFileMock, runProcessMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  runProcessMock: vi.fn()
}))
vi.mock('node:child_process', () => ({ execFile: execFileMock }))
vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))

// Inject /dev data without bypassing the production translator.
vi.mock('../../shared/darwin-terminal-names', async (importOriginal) => {
  const original = await importOriginal<typeof DarwinTerminalNames>()
  return {
    nameDarwinTerminals: (stdout: string, _deps: unknown, signal?: AbortSignal) =>
      psFixture.nameTerminals(original.nameDarwinTerminals, stdout, signal)
  }
})

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  readFile: async (path: string) => readProcStatMock(path)
}))

let cheapReader: typeof CheapReader
let fullReader: typeof FullReader
let trackerModule: typeof TrackerModule
let inspection: typeof Inspection

const PANE_COUNT = 8
const IDLE_POLL_INTERVAL_MS = 2_000 // POLL_TIER_INTERVAL_MS.idle
const WINDOW_SECONDS = 60
const TICKS = Math.floor((WINDOW_SECONDS * 1000) / IDLE_POLL_INTERVAL_MS)

const shellPid = (pane: number): number => 1000 + pane * 100
const agentPid = (pane: number): number => shellPid(pane) + 1

type PaneState = { agent: boolean; agentStart: string; agentStartTicks: number }
const panes: PaneState[] = Array.from({ length: PANE_COUNT }, () => ({
  agent: true,
  agentStart: 'Thu Sep  3 16:02:05 2026',
  agentStartTicks: 1_400
}))

const forks = { full: 0, cheap: 0 }

function processRows(): PsFixtureRow[] {
  return panes.flatMap((pane, i) => {
    const shell = shellPid(i)
    const agent = agentPid(i)
    const rows: PsFixtureRow[] = [
      {
        pid: shell,
        ppid: 1,
        pgid: shell,
        tpgid: pane.agent ? agent : shell,
        stat: pane.agent ? 'Ss' : 'Ss+',
        terminalMinor: i,
        startTime: 'Thu Sep  3 16:02:01 2026',
        startTicks: 1_000,
        command: '-zsh'
      }
    ]
    if (pane.agent) {
      rows.push({
        pid: agent,
        ppid: shell,
        pgid: agent,
        tpgid: agent,
        stat: 'S+',
        terminalMinor: i,
        startTime: pane.agentStart,
        startTicks: pane.agentStartTicks,
        command: 'node /usr/local/bin/claude'
      })
    }
    return rows
  })
}
const psFixture = createProcessTablePsFixture(processRows)
const readProcStatMock = vi.fn((path: string) => psFixture.readProcStat(path))

function installCountingPs(): void {
  execFileMock.mockImplementation(
    (
      cmd: string,
      args: string[],
      _opts: unknown,
      callback: (err: unknown, r: { stdout: string; stderr: string }) => void
    ) => {
      expect(cmd).toBe('ps')
      expect(args).toEqual(
        process.platform === 'darwin'
          ? ['-axo', 'pid=,ppid=,pgid=,tpgid=,stat=,tdev=,lstart=,command=']
          : ['-axo', 'pid=,ppid=,pgid=,tpgid=,stat=,tty=,etimes=,command=']
      )
      forks.full += 1
      callback(null, {
        stdout: psFixture.render(args[1]),
        stderr: ''
      })
    }
  )
  runProcessMock.mockImplementation(async (spec: { program: string; args: readonly string[] }) => {
    expect(spec.program).toBe('ps')
    expect(spec.args).toEqual(
      process.platform === 'darwin'
        ? ['-axo', 'pid=,ppid=,pgid=,tpgid=,stat=,lstart=']
        : ['-axo', 'pid=,ppid=,pgid=,tpgid=,stat=']
    )
    forks.cheap += 1
    return {
      code: 0,
      signal: null,
      stdout: psFixture.render(spec.args[1]),
      stderr: '',
      timedOut: false
    }
  })
}

function createSession(pane: number): Session {
  const tracker = trackerModule.createPtyForegroundProcessTracker({
    process: {
      pid: shellPid(pane),
      get process() {
        return panes[pane].agent ? 'node' : 'zsh'
      }
    } as never,
    shellPath: '/bin/zsh',
    sessionId: `wt:pane-${pane}`,
    startupAgentRecognition: null,
    isDead: () => false
  })
  return {
    pid: shellPid(pane),
    incarnationId: `inc-${pane}`,
    isAlive: true,
    getForegroundProcess: (options?: { rawFallback?: boolean }) =>
      tracker.getForegroundProcess(options)
  } as unknown as Session
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve()
  }
}

async function runTick(sessions: Session[], steadyState: boolean): Promise<(string | null)[]> {
  const results = await Promise.all(
    sessions.map((session, pane) =>
      inspection.inspectTerminalHostProcess({
        sessionId: `wt:pane-${pane}`,
        session,
        ...(steadyState ? { steadyState: true } : {}),
        authorityGeneration: 'gen',
        nextObservationEpoch: () => 1
      })
    )
  )
  await settle()
  return results.map((r) => r.foregroundProcess)
}

describe.each(['darwin', 'linux'])('cheap-tier ps scan volume (%s)', (hostPlatform) => {
  let platform: PropertyDescriptor | undefined

  beforeEach(async () => {
    execFileMock.mockReset()
    readProcStatMock.mockClear()
    runProcessMock.mockReset()
    forks.full = 0
    forks.cheap = 0
    panes.forEach((pane) => {
      pane.agent = true
      pane.agentStart = 'Thu Sep  3 16:02:05 2026'
      pane.agentStartTicks = 1_400
    })
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
    // Column constants are chosen at import time, so each host needs a fresh module graph.
    vi.resetModules()
    fullReader = await import('../../shared/process-table-snapshot-reader')
    fullReader.resetProcessTableSnapshotForTests()
    cheapReader = await import('../../shared/cheap-process-table-snapshot-reader')
    cheapReader.resetCheapProcessTableSnapshotForTests()
    trackerModule = await import('./pty-subprocess/foreground-process-tracker')
    inspection = await import('./terminal-host-process-inspection')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    installCountingPs()
  })

  afterEach(() => {
    vi.useRealTimers()
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
    if (hostPlatform === 'darwin') {
      expect(readProcStatMock).not.toHaveBeenCalled()
    } else {
      expect(readProcStatMock).toHaveBeenCalled()
    }
    // Production catches read errors; assert each path resolved against the fixture at read time.
    for (const [index, result] of readProcStatMock.mock.results.entries()) {
      expect(result.type, readProcStatMock.mock.calls[index][0]).toBe('return')
    }
  })

  it('replaces ~all full captures with cheap ones once every pane holds an anchor', async () => {
    const sessions = Array.from({ length: PANE_COUNT }, (_, pane) => createSession(pane))
    for (let tick = 0; tick < TICKS; tick += 1) {
      vi.setSystemTime(1_000_000 + tick * IDLE_POLL_INTERVAL_MS)
      const names = await runTick(sessions, true)
      expect(names.every((name) => name === 'claude')).toBe(true)
    }
    // Baseline today: one full capture per tick (TTL-shared across the 8 panes) = TICKS.
    // Now: the first tick establishes every anchor from one full capture; every later tick is
    // one TTL-shared cheap capture. Published numbers, from this run:
    //   before: 30 full (~0.34-0.50s each on macOS, 1.15s Linux) + 0 cheap
    //   after:   1 full + 29 cheap (~0.03s each)
    expect(forks.full).toBe(1)
    expect(forks.cheap).toBe(TICKS - 1)
    expect(forks.full + forks.cheap).toBe(TICKS)
  })

  it('keeps today’s cost when the caller does not opt in (old client / remote / restore)', async () => {
    const sessions = Array.from({ length: PANE_COUNT }, (_, pane) => createSession(pane))
    for (let tick = 0; tick < TICKS; tick += 1) {
      vi.setSystemTime(1_000_000 + tick * IDLE_POLL_INTERVAL_MS)
      await runTick(sessions, false)
    }
    expect(forks.cheap).toBe(0)
    expect(forks.full).toBe(TICKS)
  })

  it('completion detection is byte-for-byte unchanged: exit, idle, and restart resolve identically with and without the cheap tier', async () => {
    const script = async (steadyState: boolean): Promise<(string | null)[][]> => {
      fullReader.resetProcessTableSnapshotForTests()
      cheapReader.resetCheapProcessTableSnapshotForTests()
      panes.forEach((pane) => {
        pane.agent = true
        pane.agentStart = 'Thu Sep  3 16:02:05 2026'
        pane.agentStartTicks = 1_400
      })
      const sessions = Array.from({ length: PANE_COUNT }, (_, pane) => createSession(pane))
      const series: (string | null)[][] = []
      for (let tick = 0; tick < TICKS; tick += 1) {
        vi.setSystemTime(1_000_000 + tick * IDLE_POLL_INTERVAL_MS)
        if (tick === 5) {
          panes[2].agent = false // pane 2's agent exits
        }
        if (tick === 12) {
          panes[2].agent = true // ...and is restarted with a new start time
          panes[2].agentStart = 'Thu Sep  3 16:30:00 2026'
          panes[2].agentStartTicks = 2_000
        }
        if (tick === 20) {
          panes[6].agent = false
        }
        series.push(await runTick(sessions, steadyState))
      }
      return series
    }
    const withCheapTier = await script(true)
    const cheapForks = forks.cheap
    forks.cheap = 0
    forks.full = 0
    const fullOnly = await script(false)
    expect(withCheapTier).toEqual(fullOnly)
    // And the exit was seen on the very tick it happened, in both modes.
    expect(withCheapTier[4][2]).toBe('claude')
    expect(withCheapTier[5][2]).not.toBe('claude')
    expect(withCheapTier[12][2]).toBe('claude')
    expect(withCheapTier[19][6]).toBe('claude')
    expect(withCheapTier[20][6]).not.toBe('claude')
    expect(cheapForks).toBeGreaterThan(0)
  })
})
