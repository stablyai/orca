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
import type { TerminalHostInspectionTier } from './terminal-host-process-inspection'
import type * as AnchorModule from './terminal-host-steady-state-anchor'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
let anchorModule: typeof AnchorModule

const SHELL_PID = 4242
const AGENT_PID = 4300
const START_SHELL = 'Thu Sep  3 16:02:01 2026'
const START_AGENT = 'Thu Sep  3 16:02:05 2026'

type Table = { agent: 'claude' | 'stopped' | 'gone' | 'replaced'; children?: number }

const forks = { full: 0, cheap: 0 }
let table: Table = { agent: 'claude' }

function processRows(): PsFixtureRow[] {
  const shellTpgid = table.agent === 'claude' || table.agent === 'replaced' ? AGENT_PID : SHELL_PID
  const rows: PsFixtureRow[] = [
    {
      pid: SHELL_PID,
      ppid: 1,
      pgid: SHELL_PID,
      tpgid: shellTpgid,
      stat: shellTpgid === SHELL_PID ? 'Ss+' : 'Ss',
      terminalMinor: 4,
      startTime: START_SHELL,
      startTicks: 1_000,
      command: '-zsh'
    },
    {
      pid: 9000,
      ppid: 1,
      pgid: 9000,
      tpgid: 9000,
      stat: 'Ss+',
      terminalMinor: 9,
      startTime: 'Thu Sep  3 12:00:00 2026',
      startTicks: 500,
      command: '-zsh'
    }
  ]
  if (table.agent !== 'gone') {
    rows.push({
      pid: AGENT_PID,
      ppid: SHELL_PID,
      pgid: AGENT_PID,
      tpgid: shellTpgid,
      stat: table.agent === 'stopped' ? 'T' : 'S+',
      terminalMinor: 4,
      startTime: table.agent === 'replaced' ? 'Thu Sep  3 16:30:00 2026' : START_AGENT,
      startTicks: table.agent === 'replaced' ? 2_000 : 1_400,
      command: 'node /usr/local/bin/claude'
    })
    for (let i = 0; i < (table.children ?? 0); i += 1) {
      rows.push({
        pid: AGENT_PID + 10 + i,
        ppid: AGENT_PID,
        pgid: AGENT_PID,
        tpgid: shellTpgid,
        stat: 'S+',
        terminalMinor: 4,
        startTime: `Thu Sep  3 16:05:0${i} 2026`,
        startTicks: 1_500 + i,
        command: 'rg --files'
      })
    }
  }
  return rows
}
const psFixture = createProcessTablePsFixture(processRows)
const readProcStatMock = vi.fn((path: string) => psFixture.readProcStat(path))

function installPs(): void {
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

function createSession(processName: () => string): Session {
  let dead = false
  const tracker = trackerModule.createPtyForegroundProcessTracker({
    process: {
      pid: SHELL_PID,
      get process() {
        return processName()
      }
    } as never,
    shellPath: '/bin/zsh',
    sessionId: 'wt-1:pane-1',
    startupAgentRecognition: null,
    isDead: () => dead
  })
  return {
    pid: SHELL_PID,
    incarnationId: 'inc-1',
    get isAlive() {
      return !dead
    },
    getForegroundProcess: (options?: { rawFallback?: boolean }) =>
      tracker.getForegroundProcess(options),
    markDead: () => {
      dead = true
      tracker.markDead()
    }
  } as unknown as Session & { markDead(): void }
}

async function inspect(
  session: Session,
  options: { steadyState?: boolean; expectedIncarnationId?: string } = {}
): Promise<{
  tier: TerminalHostInspectionTier
  result: Awaited<ReturnType<typeof inspection.inspectTerminalHostProcess>>
}> {
  let tier: TerminalHostInspectionTier = 'full'
  const result = await inspection.inspectTerminalHostProcess({
    sessionId: 'wt-1:pane-1',
    session,
    ...options,
    authorityGeneration: 'gen-1',
    nextObservationEpoch: () => 1,
    onTier: (t) => {
      tier = t
    }
  })
  return { tier, result }
}

async function settle(): Promise<void> {
  // The tracker's recognizing refresh runs off the same TTL-shared capture; let it land.
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve()
  }
}

async function advance(ms: number): Promise<void> {
  vi.setSystemTime(Date.now() + ms)
}

describe.each(['darwin', 'linux'])('daemon cheap-tier process inspection (%s)', (hostPlatform) => {
  let platform: PropertyDescriptor | undefined

  beforeEach(async () => {
    execFileMock.mockReset()
    readProcStatMock.mockClear()
    runProcessMock.mockReset()
    forks.full = 0
    forks.cheap = 0
    table = { agent: 'claude' }
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
    anchorModule = await import('./terminal-host-steady-state-anchor')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    installPs()
  })

  afterEach(() => {
    vi.useRealTimers()
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
    if (hostPlatform === 'darwin') {
      expect(readProcStatMock).not.toHaveBeenCalled()
    }
    // Production catches read errors; assert each path resolved against the fixture at read time.
    for (const [index, result] of readProcStatMock.mock.results.entries()) {
      expect(result.type, readProcStatMock.mock.calls[index][0]).toBe('return')
    }
  })

  /** Bring a session to a recognized anchor the way production does: one full cadence tick. */
  async function anchoredSession(): Promise<Session> {
    const session = createSession(() => 'node')
    const first = await inspect(session, { steadyState: true })
    await settle()
    expect(first.tier).toBe('full')
    expect(first.result.foregroundProcess).toBe('claude')
    expect(first.result.foregroundProcessEvidence).toMatchObject({
      verdict: 'live',
      processName: 'claude'
    })
    expect(anchorModule.getSteadyStateAnchor(session)?.agentName).toBe('claude')
    return session
  }

  it('a pane with NO recognized anchor never takes the cheap path, even when asked', async () => {
    table = { agent: 'gone' }
    const session = createSession(() => 'zsh')
    for (let tick = 0; tick < 5; tick += 1) {
      await advance(2_000)
      const { tier, result } = await inspect(session, { steadyState: true })
      expect(tier).toBe('full')
      expect(result.foregroundProcessEvidence).toBeDefined()
    }
    expect(forks.cheap).toBe(0)
    expect(forks.full).toBe(5)
  })

  it('serves an unchanged anchored pane from the cheap tier and OMITS evidence rather than faking it', async () => {
    const session = await anchoredSession()
    const fullBefore = forks.full
    for (let tick = 0; tick < 4; tick += 1) {
      await advance(2_000)
      const { tier, result } = await inspect(session, { steadyState: true })
      expect(tier).toBe('cheap')
      expect(result.foregroundProcess).toBe('claude')
      expect(result.hasChildProcesses).toBe(true)
      expect(result).not.toHaveProperty('foregroundProcessEvidence')
    }
    expect(forks.cheap).toBe(4)
    expect(forks.full).toBe(fullBefore)
    if (hostPlatform === 'linux') {
      expect(readProcStatMock).toHaveBeenCalled()
    }
  })

  it('a request without steadyState (old client, remote client, restore path) always gets the full capture with evidence', async () => {
    const session = await anchoredSession()
    await advance(2_000)
    const { tier, result } = await inspect(session)
    expect(tier).toBe('full')
    expect(result.foregroundProcessEvidence).toMatchObject({
      verdict: 'live',
      processName: 'claude'
    })
    expect(forks.cheap).toBe(0)
  })

  it('escalates to the full capture the moment the agent exits, and reports the exit', async () => {
    const session = await anchoredSession()
    await advance(2_000)
    expect((await inspect(session, { steadyState: true })).tier).toBe('cheap')
    table = { agent: 'gone' }
    await advance(2_000)
    const { tier, result } = await inspect(session, { steadyState: true })
    expect(tier).toBe('full')
    expect(result.foregroundProcessEvidence).toMatchObject({ verdict: 'live', processName: null })
  })

  it.each<[string, Table]>([
    ['Ctrl-Z stops the agent', { agent: 'stopped' }],
    ['exit-and-replace reuses the pid', { agent: 'replaced' }],
    ['a child spawns under the agent', { agent: 'claude', children: 1 }]
  ])('escalates when %s', async (_name, next) => {
    const session = await anchoredSession()
    await advance(2_000)
    expect((await inspect(session, { steadyState: true })).tier).toBe('cheap')
    table = next
    await advance(2_000)
    expect((await inspect(session, { steadyState: true })).tier).toBe('full')
  })

  it('escalates when node-pty reports a different foreground name, without waiting on ps', async () => {
    let name = 'node'
    const session = createSession(() => name)
    await inspect(session, { steadyState: true })
    await settle()
    await advance(2_000)
    expect((await inspect(session, { steadyState: true })).tier).toBe('cheap')
    name = 'zsh'
    await advance(2_000)
    const cheapBefore = forks.cheap
    expect((await inspect(session, { steadyState: true })).tier).toBe('full')
    expect(forks.cheap).toBe(cheapBefore)
  })

  it('falls through to the full capture when the cheap fork fails, and after an incarnation mismatch', async () => {
    const session = await anchoredSession()
    await advance(2_000)
    runProcessMock.mockRejectedValueOnce(new Error('ps died'))
    expect((await inspect(session, { steadyState: true })).tier).toBe('full')
    await advance(2_000)
    const mismatched = await inspect(session, { steadyState: true, expectedIncarnationId: 'other' })
    expect(mismatched.tier).toBe('full')
    expect(mismatched.result.foregroundProcessEvidence).toMatchObject({
      reason: 'incarnation_mismatch'
    })
  })

  it('a dead session is never served from its anchor', async () => {
    const session = (await anchoredSession()) as Session & { markDead(): void }
    session.markDead()
    await expect(inspect(session, { steadyState: true })).rejects.toThrow('not found')
    expect(forks.cheap).toBe(0)
  })

  it('an anchor is dropped when a full capture stops naming a recognized agent', async () => {
    const session = await anchoredSession()
    table = { agent: 'gone' }
    await advance(2_000)
    await inspect(session, { steadyState: true })
    expect(anchorModule.getSteadyStateAnchor(session)).toBeNull()
    // Back with a new agent, but the pane must re-anchor via a FULL capture first.
    table = { agent: 'claude' }
    await advance(2_000)
    const cheapBefore = forks.cheap
    expect((await inspect(session, { steadyState: true })).tier).toBe('full')
    expect(forks.cheap).toBe(cheapBefore)
  })
})
