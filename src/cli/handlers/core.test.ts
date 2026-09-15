import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

// The claude-teams handler spawns `claude` via node:child_process; mock it so we
// can inspect the child env without launching a real process.
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

// Keep the socket runtime client out of the import graph; only the error type
// and serveOrcaApp binding are referenced by the module under test.
vi.mock('../runtime-client', () => ({
  RuntimeClientError: class RuntimeClientError extends Error {
    readonly code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  },
  serveOrcaApp: vi.fn()
}))

import { CORE_HANDLERS } from './core'
import type { HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'

type SpawnEnv = Record<string, string | undefined>

// Minimal child stub: the handler only awaits `exit`, so resolve it on the next
// microtask to complete the spawned-process promise deterministically.
function mockClaudeChild(): { once: (event: string, cb: (...args: unknown[]) => void) => unknown } {
  const child = {
    once(event: string, cb: (...args: unknown[]) => void) {
      if (event === 'exit') {
        queueMicrotask(() => cb(0, null))
      }
      return child
    }
  }
  return child
}

describe('orca claude-teams CLI handler', () => {
  const isWindows = process.platform === 'win32'
  let previousRunAsNode: string | undefined
  let previousPaneKey: string | undefined
  let previousExitCode: typeof process.exitCode

  const callMock = vi.fn()
  const client = { call: callMock } as unknown as RuntimeClient

  function runClaudeTeams(): Promise<void> {
    const ctx: HandlerContext = {
      flags: new Map(),
      client,
      cwd: '/tmp/repo',
      json: false,
      rawArgs: []
    }
    return CORE_HANDLERS['claude-teams'](ctx)
  }

  beforeEach(() => {
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => mockClaudeChild())
    callMock.mockReset()
    callMock.mockResolvedValue({
      result: {
        launch: { env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1', PATH: '/shim:/usr/bin' } }
      }
    })
    previousRunAsNode = process.env.ELECTRON_RUN_AS_NODE
    previousPaneKey = process.env.ORCA_PANE_KEY
    previousExitCode = process.exitCode
    // The `orca` launcher runs Orca's Electron binary as Node, so the CLI process
    // itself carries ELECTRON_RUN_AS_NODE=1. Reproduce that inherited flag here.
    process.env.ELECTRON_RUN_AS_NODE = '1'
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
  })

  afterEach(() => {
    if (previousRunAsNode === undefined) {
      delete process.env.ELECTRON_RUN_AS_NODE
    } else {
      process.env.ELECTRON_RUN_AS_NODE = previousRunAsNode
    }
    if (previousPaneKey === undefined) {
      delete process.env.ORCA_PANE_KEY
    } else {
      process.env.ORCA_PANE_KEY = previousPaneKey
    }
    process.exitCode = previousExitCode
  })

  // Guarded to non-Windows: the handler early-returns unsupported_platform on
  // win32, so the leak path never runs there.
  it.skipIf(isWindows)(
    'does not leak ELECTRON_RUN_AS_NODE into the spawned claude child',
    async () => {
      await runClaudeTeams()

      expect(spawnMock).toHaveBeenCalledWith('claude', expect.any(Array), expect.any(Object))
      const spawnEnv = spawnMock.mock.calls.at(-1)?.[2].env as SpawnEnv
      expect(spawnEnv.ELECTRON_RUN_AS_NODE).toBeUndefined()

      // The prepareLaunch request env is built from the same helper, so it must
      // be sanitized too.
      const prepareLaunchEnv = (callMock.mock.calls[0][1] as { env: SpawnEnv }).env
      expect(prepareLaunchEnv.ELECTRON_RUN_AS_NODE).toBeUndefined()
    }
  )

  it.skipIf(isWindows)(
    'still forwards non-Electron parent env and prepareLaunch env to claude',
    async () => {
      const previousMarker = process.env.ORCA_TEST_MARKER
      process.env.ORCA_TEST_MARKER = 'keep-me'
      try {
        await runClaudeTeams()
      } finally {
        if (previousMarker === undefined) {
          delete process.env.ORCA_TEST_MARKER
        } else {
          process.env.ORCA_TEST_MARKER = previousMarker
        }
      }

      const spawnEnv = spawnMock.mock.calls.at(-1)?.[2].env as SpawnEnv
      expect(spawnEnv.ORCA_TEST_MARKER).toBe('keep-me')
      expect(spawnEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1')
      expect(spawnEnv.PATH).toBe('/shim:/usr/bin')
    }
  )
})

describe('orca serve stats CLI handler', () => {
  const callMock = vi.fn()
  const client = { call: callMock } as unknown as RuntimeClient

  beforeEach(() => {
    callMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('calls serve.stats and prints human-readable factory counts', async () => {
    callMock.mockResolvedValue({
      id: 'req-stats',
      ok: true,
      result: {
        version: '1.4.156-test',
        runtimeId: 'rt-boot-1',
        uptimeSeconds: 99,
        port: 6768,
        counts: {
          agents: 1,
          tasks: 2,
          terminals: 3,
          terminalsUnverifiable: 2,
          terminalsExited: 5,
          worktrees: 4,
          browserPages: 9,
          browserPagesRetained: 6,
          // #14552: one 1.3 GB renderer inside a 2.1 GB total across the six pages.
          browserPageMemoryTotalBytes: 2100000000,
          browserPageMemoryMaxBytes: 1300000000,
          tasksByStatus: {
            pending: 0,
            ready: 1,
            dispatched: 1,
            completed: 14,
            failed: 6,
            blocked: 0
          },
          agentsByState: { working: 1, permission: 0, idle: 0, unknown: 0 },
          workersByTerminalState: {
            active: 1,
            reclaimable: 271,
            retained: 370,
            release_pending: 0,
            release_unknown: 13,
            released: 16
          }
        },
        // Values from #14552 (loadavg 6.85 on 4 cores, 2.5 GB swap in use) and #19312 (new
        // connections hung 15s+ while the unit reported healthy).
        host: {
          loadAverage1m: 6.85,
          cpuCoreCount: 4,
          memoryTotalBytes: 8589934592,
          memoryAvailableBytes: 1073741824,
          memoryAvailableSource: 'proc-meminfo',
          swapUsedBytes: 2500000000,
          // #18789: 4090 pids against a 4096 ceiling.
          pids: { current: 4090, max: 4096 }
        },
        health: {
          eventLoopDelayP99Ms: 15200.5,
          // #19342: the ask sub-pool full while the total pool still had room, which is what a
          // `runtime_busy` on an idle-looking host actually looks like.
          longPolls: {
            total: { active: 8, cap: 16 },
            ask: { active: 8, cap: 8 },
            browserHost: { active: 0, cap: 8 },
            specialized: { active: 8, cap: 12 }
          }
        }
      },
      _meta: { runtimeId: 'rt-1' }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await CORE_HANDLERS['serve stats']({
      flags: new Map(),
      client,
      cwd: '/tmp',
      json: false
    })

    expect(callMock).toHaveBeenCalledWith('serve.stats')
    const out = String(log.mock.calls.map((c) => c[0]).join('\n'))
    expect(out).toContain('version: 1.4.156-test')
    expect(out).toContain('uptimeSeconds: 99')
    expect(out).toContain('port: 6768')
    expect(out).toContain('agents: 1')
    expect(out).toContain('tasks: 2')
    expect(out).toContain('terminals: 3')
    expect(out).toContain('worktrees: 4')
    expect(out).toContain('terminalsUnverifiable: 2')
    expect(out).toContain('terminalsExited: 5')
    expect(out).toContain('browserPages: 9')
    expect(out).toContain('browserPagesRetained: 6')
    expect(out).toContain('runtimeId: rt-boot-1')
    // The breakdowns render as one scannable line each, every key present.
    expect(out).toContain(
      'tasksByStatus: pending=0 ready=1 dispatched=1 completed=14 failed=6 blocked=0'
    )
    expect(out).toContain('agentsByState: working=1 permission=0 idle=0 unknown=0')
    expect(out).toContain(
      'workersByTerminalState: active=1 reclaimable=271 retained=370 release_pending=0 release_unknown=13 released=16'
    )
    // Host-wide pressure, prefixed so it is never read as Orca's own usage.
    expect(out).toContain('host.loadAverage1m: 6.85')
    expect(out).toContain('host.cpuCoreCount: 4')
    expect(out).toContain('host.memoryTotalBytes: 8589934592')
    expect(out).toContain('host.memoryAvailableBytes: 1073741824')
    expect(out).toContain('host.memoryAvailableSource: proc-meminfo')
    expect(out).toContain('host.swapUsedBytes: 2500000000')
    expect(out).toContain('health.eventLoopDelayP99Ms: 15200.5')
    expect(out).toContain('browserPageMemoryTotalBytes: 2100000000')
    expect(out).toContain('browserPageMemoryMaxBytes: 1300000000')
    expect(out).toContain('host.pids: current=4090 max=4096')
    // Both halves on one line: the cap is the number #19342's operator had to read source for.
    expect(out).toContain('health.longPolls: total=8/16 ask=8/8 browserHost=0/8 specialized=8/12')
  })

  it('prints JSON when --json is set and renders null port as none in human mode', async () => {
    callMock.mockResolvedValue({
      id: 'req-stats-json',
      ok: true,
      result: {
        version: '1.4.156-test',
        runtimeId: 'rt-1',
        uptimeSeconds: 1,
        port: null,
        counts: {
          agents: 0,
          tasks: 0,
          terminals: 0,
          terminalsUnverifiable: 0,
          terminalsExited: 0,
          worktrees: 0,
          browserPages: 0,
          browserPagesRetained: 0,
          browserPageMemoryTotalBytes: null,
          browserPageMemoryMaxBytes: null,
          tasksByStatus: {
            pending: 0,
            ready: 0,
            dispatched: 0,
            completed: 0,
            failed: 0,
            blocked: 0
          },
          agentsByState: { working: 0, permission: 0, idle: 0, unknown: 0 },
          workersByTerminalState: {
            active: 0,
            reclaimable: 0,
            retained: 0,
            release_pending: 0,
            release_unknown: 0,
            released: 0
          }
        },
        // Windows shape: no load average, no procfs swap, and a monitor that never sampled.
        host: {
          loadAverage1m: null,
          cpuCoreCount: 8,
          memoryTotalBytes: 17179869184,
          memoryAvailableBytes: 8589934592,
          memoryAvailableSource: 'free-memory',
          swapUsedBytes: null,
          pids: null
        },
        health: { eventLoopDelayP99Ms: null, longPolls: null }
      },
      _meta: { runtimeId: 'rt-1' }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await CORE_HANDLERS['serve stats']({
      flags: new Map(),
      client,
      cwd: '/tmp',
      json: true
    })

    const parsed = JSON.parse(String(log.mock.calls[0]?.[0])) as {
      result: { port: number | null; counts: { agents: number } }
    }
    expect(parsed.result.port).toBeNull()
    expect(parsed.result.counts.agents).toBe(0)

    log.mockClear()
    await CORE_HANDLERS['serve stats']({
      flags: new Map(),
      client,
      cwd: '/tmp',
      json: false
    })
    const human = String(log.mock.calls.map((c) => c[0]).join('\n'))
    expect(human).toContain('port: none')
    // Unmeasurable is never 0: a zero here would read as an idle host.
    expect(human).toContain('host.loadAverage1m: n/a')
    expect(human).toContain('host.swapUsedBytes: n/a')
    expect(human).toContain('health.eventLoopDelayP99Ms: n/a')
    // An unlimited-vs-unmeasured distinction only survives if neither renders as a number.
    expect(human).toContain('host.pids: n/a')
    expect(human).toContain('health.longPolls: n/a')
    expect(human).toContain('browserPageMemoryTotalBytes: n/a')
    expect(human).toContain('browserPageMemoryMaxBytes: n/a')
    expect(human).not.toContain('host.loadAverage1m: 0')
    expect(human).not.toContain('health.eventLoopDelayP99Ms: 0')
    expect(human).not.toContain('browserPageMemoryTotalBytes: 0')
  })

  it('renders an unlimited cgroup pid ceiling as unlimited, never as a number', async () => {
    callMock.mockResolvedValue({
      id: 'req-stats-unlimited',
      ok: true,
      result: {
        version: '1.4.156-test',
        runtimeId: 'rt-1',
        uptimeSeconds: 1,
        port: 6768,
        counts: {
          agents: 0,
          tasks: 0,
          terminals: 0,
          terminalsUnverifiable: 0,
          terminalsExited: 0,
          worktrees: 0,
          browserPages: 0,
          browserPagesRetained: 0,
          browserPageMemoryTotalBytes: null,
          browserPageMemoryMaxBytes: null,
          tasksByStatus: {
            pending: 0,
            ready: 0,
            dispatched: 0,
            completed: 0,
            failed: 0,
            blocked: 0
          },
          agentsByState: { working: 0, permission: 0, idle: 0, unknown: 0 },
          workersByTerminalState: {
            active: 0,
            reclaimable: 0,
            retained: 0,
            release_pending: 0,
            release_unknown: 0,
            released: 0
          }
        },
        host: {
          loadAverage1m: 0.4,
          cpuCoreCount: 8,
          memoryTotalBytes: 17179869184,
          memoryAvailableBytes: 8589934592,
          memoryAvailableSource: 'proc-meminfo',
          swapUsedBytes: 0,
          // A cgroup whose `pids.max` is the literal `max`: current is measured, and there is no
          // ceiling to report.
          pids: { current: 143, max: null }
        },
        health: { eventLoopDelayP99Ms: 1.5, longPolls: null }
      },
      _meta: { runtimeId: 'rt-1' }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await CORE_HANDLERS['serve stats']({
      flags: new Map(),
      client,
      cwd: '/tmp',
      json: false
    })

    const out = String(log.mock.calls.map((c) => c[0]).join('\n'))
    // Neither 0 (which reads as "no pids allowed") nor n/a (which reads as "not measured").
    expect(out).toContain('host.pids: current=143 max=unlimited')
  })
})
