import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Two seams because the two tiers spawn differently: the full evidence reader still forks
// through node:child_process, the cheap reader through Orca's runProcess entry point.
const { execFileMock, runProcessMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  runProcessMock: vi.fn()
}))
vi.mock('node:child_process', () => ({ execFile: execFileMock }))
vi.mock('../../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))

import { resetCheapProcessTableSnapshotForTests } from '../../shared/cheap-process-table-snapshot-reader'
import { resetProcessTableSnapshotForTests } from '../../shared/process-table-snapshot-reader'
import { createPtyForegroundProcessTracker } from './pty-subprocess/foreground-process-tracker'
import {
  inspectTerminalHostProcess,
  type TerminalHostInspectionTier
} from './terminal-host-process-inspection'
import { getSteadyStateAnchor } from './terminal-host-steady-state-anchor'
import type { Session } from './session'

const SHELL_PID = 4242
const AGENT_PID = 4300
const START_SHELL = 'Thu Sep  3 16:02:01 2026'
const START_AGENT = 'Thu Sep  3 16:02:05 2026'

type Table = { agent: 'claude' | 'stopped' | 'gone' | 'replaced'; children?: number }

/** One host table rendered in both column sets, so each fork answers by the args it asked for. */
function renderTable(table: Table): { full: string; cheap: string } {
  const shellTpgid = table.agent === 'claude' || table.agent === 'replaced' ? AGENT_PID : SHELL_PID
  const shellStat = shellTpgid === SHELL_PID ? 'Ss+' : 'Ss'
  const rows: { cheap: string; full: string }[] = [
    {
      cheap: `${SHELL_PID} 1 ${SHELL_PID} ${shellTpgid} ${shellStat} ${START_SHELL}`,
      full: `${SHELL_PID} 1 ${SHELL_PID} ${shellTpgid} ${shellStat} ttys004 ${START_SHELL} -zsh`
    },
    {
      cheap: `9000 1 9000 9000 Ss+ Thu Sep  3 12:00:00 2026`,
      full: `9000 1 9000 9000 Ss+ ttys009 Thu Sep  3 12:00:00 2026 -zsh`
    }
  ]
  if (table.agent !== 'gone') {
    const stat = table.agent === 'stopped' ? 'T' : 'S+'
    const start = table.agent === 'replaced' ? 'Thu Sep  3 16:30:00 2026' : START_AGENT
    rows.push({
      cheap: `${AGENT_PID} ${SHELL_PID} ${AGENT_PID} ${shellTpgid} ${stat} ${start}`,
      full: `${AGENT_PID} ${SHELL_PID} ${AGENT_PID} ${shellTpgid} ${stat} ttys004 ${start} node /usr/local/bin/claude`
    })
    for (let i = 0; i < (table.children ?? 0); i += 1) {
      const pid = AGENT_PID + 10 + i
      rows.push({
        cheap: `${pid} ${AGENT_PID} ${AGENT_PID} ${shellTpgid} S+ Thu Sep  3 16:05:0${i} 2026`,
        full: `${pid} ${AGENT_PID} ${AGENT_PID} ${shellTpgid} S+ ttys004 Thu Sep  3 16:05:0${i} 2026 rg --files`
      })
    }
  }
  return {
    full: `${rows.map((r) => r.full).join('\n')}\n`,
    cheap: `${rows.map((r) => r.cheap).join('\n')}\n`
  }
}

const forks = { full: 0, cheap: 0 }
let table: Table = { agent: 'claude' }

function installPs(): void {
  execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: unknown) => {
    expect(args[1]).toContain('command=')
    forks.full += 1
    ;(cb as (err: unknown, r: { stdout: string; stderr: string }) => void)(null, {
      stdout: renderTable(table).full,
      stderr: ''
    })
  })
  runProcessMock.mockImplementation(async (spec: { args: readonly string[] }) => {
    expect(spec.args[1]).not.toContain('command=')
    forks.cheap += 1
    return {
      code: 0,
      signal: null,
      stdout: renderTable(table).cheap,
      stderr: '',
      timedOut: false
    }
  })
}

function createSession(processName: () => string): Session {
  let dead = false
  const tracker = createPtyForegroundProcessTracker({
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
  result: Awaited<ReturnType<typeof inspectTerminalHostProcess>>
}> {
  let tier: TerminalHostInspectionTier = 'full'
  const result = await inspectTerminalHostProcess({
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

describe('daemon cheap-tier process inspection', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    execFileMock.mockReset()
    runProcessMock.mockReset()
    resetProcessTableSnapshotForTests()
    resetCheapProcessTableSnapshotForTests()
    forks.full = 0
    forks.cheap = 0
    table = { agent: 'claude' }
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    installPs()
  })

  afterEach(() => {
    vi.useRealTimers()
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  /** Bring a session to a recognized anchor the way production does: one full cadence tick. */
  async function anchoredSession(): Promise<Session> {
    const session = createSession(() => 'node')
    const first = await inspect(session, { steadyState: true })
    await settle()
    expect(first.tier).toBe('full')
    expect(first.result.foregroundProcess).toBe('claude')
    expect(getSteadyStateAnchor(session)?.agentName).toBe('claude')
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
    expect(getSteadyStateAnchor(session)).toBeNull()
    // Back with a new agent, but the pane must re-anchor via a FULL capture first.
    table = { agent: 'claude' }
    await advance(2_000)
    const cheapBefore = forks.cheap
    expect((await inspect(session, { steadyState: true })).tier).toBe('full')
    expect(forks.cheap).toBe(cheapBefore)
  })
})
