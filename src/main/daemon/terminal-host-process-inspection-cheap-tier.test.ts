import type { IPty } from 'node-pty'
import type * as InterfaceEvidence from '../providers/terminal-interface-process-evidence'
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

// Full and cheap readers use different process entry points, so mock both.
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
let interfaceEvidence: typeof InterfaceEvidence

const SHELL_PID = 4242
const AGENT_PID = 4300
const START_SHELL = 'Thu Sep  3 16:02:01 2026'
const START_AGENT = 'Thu Sep  3 16:02:05 2026'

type Table = { agent: 'claude' | 'stopped' | 'gone' | 'replaced'; children?: number }

const forks = { full: 0, cheap: 0, narrow: 0 }
let population = 1
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
  return Array.from({ length: population }, (_, index) =>
    rows.map((row) => ({
      ...row,
      pid: row.pid + index * 10000,
      ppid: row.ppid === 1 ? 1 : row.ppid + index * 10000,
      pgid: row.pgid + index * 10000,
      tpgid: row.tpgid + index * 10000,
      terminalMinor: row.terminalMinor + index * 10
    }))
  ).flat()
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
      if (args[1] === 'pid=,ppid=,pgid=,tpgid=,stat=,command=') {
        forks.narrow += 1
        callback(null, { stdout: psFixture.render(args[1]), stderr: '' })
        return
      }
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

type FixtureSession = Session & { markDead(): void }

function createSession(processName: () => string, rootPid = SHELL_PID): FixtureSession {
  let dead = false
  const process: IPty = {
    pid: rootPid,
    cols: 80,
    rows: 24,
    get process() {
      return processName()
    },
    handleFlowControl: false,
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
    resize() {},
    clear() {},
    write() {},
    kill() {},
    pause() {},
    resume() {}
  }
  const tracker = trackerModule.createPtyForegroundProcessTracker({
    process,
    shellPath: '/bin/zsh',
    sessionId: 'wt-1:pane-1',
    startupAgentRecognition: null,
    isDead: () => dead
  })
  const session: Pick<
    Session,
    'pid' | 'inspectTerminalInterface' | 'incarnationId' | 'isAlive' | 'getForegroundProcess'
  > & { markDead(): void } = {
    pid: rootPid,
    inspectTerminalInterface: (
      snapshot?: Parameters<typeof interfaceEvidence.inspectPosixTerminalInterface>[3]
    ) => interfaceEvidence.inspectPosixTerminalInterface(rootPid, '/bin/zsh', false, snapshot),
    incarnationId: '00000000-0000-4000-8000-000000000001',
    get isAlive() {
      return !dead
    },
    getForegroundProcess: (options?: { rawFallback?: boolean }) =>
      tracker.getForegroundProcess(options),
    markDead: () => {
      dead = true
      tracker.markDead()
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: inspection uses only these checked public members; constructing Session would start an unrelated PTY output pipeline.
  return session as unknown as FixtureSession
}

async function inspect(
  session: Session,
  options: {
    steadyState?: boolean
    terminalInterface?: boolean
    expectedIncarnationId?: string
  } = {}
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
  // Let the recognizing refresh settle on the same shared process-table capture.
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
    forks.narrow = 0
    table = { agent: 'claude' }
    population = 1
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
    interfaceEvidence = await import('../providers/terminal-interface-process-evidence')
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

  async function anchoredSession(): Promise<FixtureSession> {
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

  it.each([1, 10, 100])(
    'shares full discovery and cheap continuity across %i real terminal subtrees',
    async (size) => {
      population = size
      const sessions = Array.from({ length: size }, (_, index) =>
        createSession(() => 'node', SHELL_PID + index * 10000)
      )
      for (const session of sessions) {
        const { result } = await inspect(session, { terminalInterface: true })
        expect(result.terminalInterface).toMatchObject({
          shellForeground: false,
          children: 'children'
        })
        await advance(1)
      }
      const discovery = { ...forks }
      expect(discovery).toEqual({ full: 1, cheap: 0, narrow: 0 })
      await advance(2000)
      for (const session of sessions) {
        const { tier, result } = await inspect(session, {
          terminalInterface: true,
          steadyState: true
        })
        expect(tier).toBe('cheap')
        expect(result.foregroundProcess).toBe('claude')
        expect(result).not.toHaveProperty('terminalInterface')
        await advance(1)
      }
      expect(forks).toEqual({ full: 1, cheap: 1, narrow: 0 })
      await Promise.all(sessions.map(() => fullReader.getFreshShellForegroundSnapshot()))
      expect(forks).toEqual({
        full: hostPlatform === 'darwin' ? 1 : 2,
        cheap: 1,
        narrow: hostPlatform === 'darwin' ? 1 : 0
      })
      process.stdout.write(
        `INTERFACE_CAPTURE_BOUND ${JSON.stringify({ hostPlatform, size, discovery, steady: forks })}\n`
      )
    }
  )

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
    const session = await anchoredSession()
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
    // A returning agent must establish fresh identity through a full capture.
    table = { agent: 'claude' }
    population = 1
    await advance(2_000)
    const cheapBefore = forks.cheap
    expect((await inspect(session, { steadyState: true })).tier).toBe('full')
    expect(forks.cheap).toBe(cheapBefore)
  })
})
