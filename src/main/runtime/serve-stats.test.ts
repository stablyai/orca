import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'

// Why: StatsCollector still reads its snapshot path from electron's `app` at
// construction (src/main/stats/collector.ts), so it needs this mock even though
// the runtime itself reads version through the AppEnvironment port. liveAgents
// (the agents count source) is never persisted, so a temp path reads nothing back.
// `getAppPath` is for AgentBrowserBridge: it resolves the agent-browser binary at construction,
// and the offscreen-page case below builds a real bridge over a mocked BrowserManager.
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getAppPath: () => tmpdir() } }))

import { OrchestrationDb } from './orchestration/db'
import { OrcaRuntimeService } from './orca-runtime'
import { StatsCollector } from '../stats/collector'
import { getBrowserHostLeaseRegistry } from './browser-host-lease-registry-instance'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import type { RuntimeBrowserPlacement } from '../../shared/runtime-browser-placement'
import { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import { mockBrowserManager } from '../browser/agent-browser-bridge-test-harness'

const ZERO_TASK_STATUS_COUNTS = {
  pending: 0,
  ready: 0,
  dispatched: 0,
  completed: 0,
  failed: 0,
  blocked: 0
}
const ZERO_AGENT_STATE_COUNTS = { working: 0, permission: 0, idle: 0, unknown: 0 }
const ZERO_WORKER_TERMINAL_STATE_COUNTS = {
  active: 0,
  reclaimable: 0,
  retained: 0,
  release_pending: 0,
  release_unknown: 0,
  released: 0
}

describe('getServeStats', () => {
  let db: OrchestrationDb | null = null

  // Why: the global setup installs a fake with version 0.0.0-test; pin a
  // distinctive one so the assertion proves getServeStats reads the port
  // rather than matching a default by coincidence.
  beforeEach(() => {
    installFakeAppEnvironment({ getVersion: () => '9.9.9-test' })
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.clearAllMocks()
  })

  it('aggregates live runtime counts, version, port and uptime', async () => {
    const stats = new StatsCollector()
    stats.onAgentStart('pty-1', Date.now())
    stats.onAgentStart('pty-2', Date.now())

    const runtime = new OrcaRuntimeService(null, stats)
    db = new OrchestrationDb(':memory:')
    const runId = seedRun(db)
    db.createTask({ spec: 'first task', runId })
    db.createTask({ spec: 'second task', runId })
    runtime.setOrchestrationDb(db)
    runtime.setServePort(6970)

    // Why: worktree counts come from listManagedWorktrees, which needs a store.
    // The store is orthogonal to this aggregation, so stub the count directly.
    vi.spyOn(runtime, 'listManagedWorktrees').mockResolvedValue({
      worktrees: [],
      totalCount: 3,
      truncated: false
    })

    const result = await runtime.getServeStats()

    expect(result).toEqual({
      version: '9.9.9-test',
      runtimeId: runtime.getRuntimeId(),
      uptimeSeconds: expect.any(Number),
      port: 6970,
      counts: {
        agents: 0,
        tasks: 2,
        terminals: 0,
        terminalsUnverifiable: 0,
        terminalsExited: 0,
        worktrees: 3,
        browserPages: 0,
        browserPagesRetained: 0,
        // No pages at all, so no renderer footprint was measurable: null, never a 0 that would
        // read as pages costing nothing.
        browserPageMemoryTotalBytes: null,
        browserPageMemoryMaxBytes: null,
        // Dependency-free tasks are admitted straight to `ready`.
        tasksByStatus: { ...ZERO_TASK_STATUS_COUNTS, ready: 2 },
        agentsByState: ZERO_AGENT_STATE_COUNTS,
        workersByTerminalState: ZERO_WORKER_TERMINAL_STATE_COUNTS
      },
      // Host readings come from node:os / procfs, so which of them are measurable depends on the
      // platform (asserted field-by-field below); the unmeasurable cases are covered exhaustively
      // in serve-stats-host.test.ts.
      host: expect.any(Object),
      // No RPC listener started in this test, so the histogram was never enabled: null, not 0.
      // `longPolls` is null for the same reason — the caps belong to the server, and there is none.
      health: { eventLoopDelayP99Ms: null, longPolls: null }
    })
    expect(result.uptimeSeconds).toBeGreaterThanOrEqual(0)
  })

  it('reports host-wide load, cpu, memory and swap alongside the Orca counts', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = runtimeWithStubbedWorktrees(db)

    const host = (await runtime.getServeStats()).host

    // Every key is present, so a reader never has to distinguish "absent" from "unmeasurable".
    expect(Object.keys(host).sort()).toEqual([
      'cpuCoreCount',
      'loadAverage1m',
      'memoryAvailableBytes',
      'memoryAvailableSource',
      'memoryTotalBytes',
      'pids',
      'swapUsedBytes'
    ])
    expect(host.cpuCoreCount).toBeGreaterThan(0)
    expect(host.memoryTotalBytes).toBeGreaterThan(0)
    expect(host.memoryAvailableBytes).toBeGreaterThan(0)
    expect(host.memoryAvailableBytes).toBeLessThanOrEqual(host.memoryTotalBytes)
    expect(['proc-meminfo', 'free-memory']).toContain(host.memoryAvailableSource)
    // Measurable on this platform; the null shape is proven against a stubbed win32 host.
    if (process.platform === 'win32') {
      expect(host.loadAverage1m).toBeNull()
    } else {
      expect(host.loadAverage1m).toBeGreaterThanOrEqual(0)
    }
    // Swap and MemAvailable share one procfs read, so they must agree: both measured, or both
    // absent on a container with no procfs. Neither may report a fabricated 0.
    if (host.memoryAvailableSource === 'proc-meminfo') {
      expect(host.swapUsedBytes).toBeGreaterThanOrEqual(0)
    } else {
      expect(host.swapUsedBytes).toBeNull()
    }
    // cgroup v2 only: measured here, and null on a host with no pid controller to read. Never 0.
    if (host.pids !== null) {
      expect(host.pids.current).toBeGreaterThan(0)
      expect(host.pids.max === null || host.pids.max >= host.pids.current).toBe(true)
    }
  })

  it('reports a null port when no server has bound one', async () => {
    const runtime = new OrcaRuntimeService(null)
    db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'listManagedWorktrees').mockResolvedValue({
      worktrees: [],
      totalCount: 0,
      truncated: false
    })

    const result = await runtime.getServeStats()

    expect(result.port).toBeNull()
    expect(result.counts).toEqual({
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
      tasksByStatus: ZERO_TASK_STATUS_COUNTS,
      agentsByState: ZERO_AGENT_STATE_COUNTS,
      workersByTerminalState: ZERO_WORKER_TERMINAL_STATE_COUNTS
    })
  })

  it('reports the live long-poll budget the RPC server registers, and null once it clears it', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = runtimeWithStubbedWorktrees(db)

    // Nothing is serving yet, so there is no admission budget: null, never 0/0, which would read
    // as a runtime that can admit no long poll at all.
    expect((await runtime.getServeStats()).health.longPolls).toBeNull()

    // The server owns the counters; it registers a reader the way it sets the serve port. A pull,
    // so a value read here is the one admission would fence against right now (#19342).
    let active = 0
    runtime.setLongPollStatsProvider(() => ({
      total: { active, cap: 16 },
      ask: { active, cap: 8 },
      browserHost: { active: 0, cap: 8 },
      specialized: { active, cap: 12 }
    }))
    active = 8

    expect((await runtime.getServeStats()).health.longPolls).toEqual({
      total: { active: 8, cap: 16 },
      // The ask sub-pool full while the total pool still has room is exactly the state that
      // rejects an ask with `runtime_busy` on an otherwise idle host.
      ask: { active: 8, cap: 8 },
      browserHost: { active: 0, cap: 8 },
      specialized: { active: 8, cap: 12 }
    })

    runtime.setLongPollStatsProvider(null)

    expect((await runtime.getServeStats()).health.longPolls).toBeNull()
  })

  it('counts a pty that lost host contact as unverifiable, never as a terminal', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = runtimeWithStubbedWorktrees(db)
    const internals = runtime as unknown as {
      recordPtyWorktree: (
        ptyId: string,
        worktreeId: string,
        state?: { connected?: boolean }
      ) => unknown
    }
    internals.recordPtyWorktree('pty-a', 'wt-a')

    expect((await runtime.getServeStats()).counts).toMatchObject({
      terminals: 1,
      terminalsUnverifiable: 0,
      terminalsExited: 0
    })

    internals.recordPtyWorktree('pty-a', 'wt-a', { connected: false })

    // The pty is still registered; only the evidence for it is gone.
    expect((await runtime.getServeStats()).counts).toMatchObject({
      terminals: 0,
      terminalsUnverifiable: 1,
      terminalsExited: 0
    })
  })

  it('separates a pty the host reported exited from one that merely lost contact', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = runtimeWithStubbedWorktrees(db)
    const internals = runtime as unknown as {
      recordPtyWorktree: (
        ptyId: string,
        worktreeId: string,
        state?: { connected?: boolean }
      ) => unknown
    }
    internals.recordPtyWorktree('pty-exited', 'wt-a')
    internals.recordPtyWorktree('pty-silent', 'wt-a')

    // A host-delivered exit frame, the only writer of an `exited` liveness verdict.
    runtime.onPtyExit('pty-exited', 0)
    // Contact loss carrying no exit evidence at all — what a dropped relay leaves behind.
    internals.recordPtyWorktree('pty-silent', 'wt-a', { connected: false })

    // Both are registered and disconnected, but only one is proven dead. Reporting the proven one
    // as unverifiable is what emptied that field's no-cleanup warning of meaning.
    expect(runtime.getPtyLivenessVerdict('pty-exited')).toEqual({ status: 'exited' })
    expect(runtime.getPtyLivenessVerdict('pty-silent')).toBeNull()
    expect((await runtime.getServeStats()).counts).toMatchObject({
      terminals: 0,
      terminalsExited: 1,
      terminalsUnverifiable: 1
    })
  })

  it('counts every client-hosted page, and the retained subset with no live host', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = runtimeWithStubbedWorktrees(db)
    const leases = getBrowserHostLeaseRegistry(runtime)
    const quitting = attachBrowserHost(runtime, 'host-a')
    attachBrowserHost(runtime, 'host-b')
    publishClientPage(runtime, 'page-a', leases.placeClientPage('page-a', 'host-a'))
    publishClientPage(runtime, 'page-b', leases.placeClientPage('page-b', 'host-b'))

    expect((await runtime.getServeStats()).counts).toMatchObject({
      browserPages: 2,
      browserPagesRetained: 0
    })

    quitting.release()

    // The fenced page keeps its registry slot with no placement left to drive it.
    expect((await runtime.getServeStats()).counts).toMatchObject({
      browserPages: 2,
      browserPagesRetained: 1
    })
  })

  it('counts a page opened on the headless offscreen path, which holds no registry slot', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = runtimeWithStubbedWorktrees(db)
    // The map BrowserManager keys by page id: `registerOffscreenGuest` writes the id a headless
    // `tab create` returns into exactly this map, and into nothing else — a headless serve has no
    // renderer, so those pages never reach the client-hosted page registry.
    const registeredPages = new Map<string, number>()
    installBrowserBridge(runtime, registeredPages)

    expect((await runtime.getServeStats()).counts).toMatchObject({ browserPages: 0 })

    registeredPages.set('offscreen-page-a', 501)
    registeredPages.set('offscreen-page-b', 502)

    // #14552: agent-opened headless tabs are the population this field exists to expose.
    expect((await runtime.getServeStats()).counts).toMatchObject({
      browserPages: 2,
      // Offscreen pages have no separate host to lose, so retention stays a client-hosted notion.
      browserPagesRetained: 0
    })

    registeredPages.delete('offscreen-page-a')

    expect((await runtime.getServeStats()).counts).toMatchObject({ browserPages: 1 })
  })

  it('counts a page known to both populations once', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = runtimeWithStubbedWorktrees(db)
    const leases = getBrowserHostLeaseRegistry(runtime)
    attachBrowserHost(runtime, 'host-a')
    publishClientPage(runtime, 'page-a', leases.placeClientPage('page-a', 'host-a'))
    const registeredPages = new Map<string, number>([
      ['page-a', 501],
      ['offscreen-page-b', 502]
    ])
    installBrowserBridge(runtime, registeredPages)

    expect((await runtime.getServeStats()).counts).toMatchObject({ browserPages: 2 })
  })

  it('publishes every task status, including the settled rows counts.tasks drops', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = runtimeWithStubbedWorktrees(db)
    const runId = seedRun(db)
    const ready = db.createTask({ spec: 'ready work', runId })
    const dispatched = db.createTask({ spec: 'dispatched work', runId })
    const completed = db.createTask({ spec: 'finished work', runId })
    const failed = db.createTask({ spec: 'broken work', runId })
    // `dispatched` is gated on an active Dispatch; the histogram only reads the column.
    db.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('dispatched', dispatched.id)
    db.updateTaskStatus(completed.id, 'completed')
    db.updateTaskStatus(failed.id, 'failed')

    const counts = (await runtime.getServeStats()).counts

    expect(counts.tasksByStatus).toEqual({
      ...ZERO_TASK_STATUS_COUNTS,
      ready: 1,
      dispatched: 1,
      completed: 1,
      failed: 1
    })
    // The histogram is the only place the settled pile is visible: counts.tasks excludes it.
    expect(counts.tasks).toBe(2)
    expect(ready.status).toBe('ready')
  })

  it('groups worker terminals by the state their release actually reached', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = runtimeWithStubbedWorktrees(db)
    const runId = seedRun(db)
    const reclaimable = seedFailedWorkerTerminal(db, runId, 'term_reclaimable', true)
    const handleOnly = seedFailedWorkerTerminal(db, runId, 'term_retained', false)
    const releasing = seedFailedWorkerTerminal(db, runId, 'term_releasing', true)
    db.requestWorkerTerminalRelease(releasing)

    expect((await runtime.getServeStats()).counts.workersByTerminalState).toEqual({
      ...ZERO_WORKER_TERMINAL_STATE_COUNTS,
      // Settled work still holding an owned terminal — the #19388 pileup.
      reclaimable: 1,
      // A handle with no owned resource behind it can only be retained.
      retained: 1,
      release_pending: 1
    })

    const resource = db.getWorkerTerminalResourceByOwner(releasing)
    db.markWorkerTerminalReleaseUnknown(resource!.id, 'tab_not_found')

    // #18737: an unprovable release must read as release_unknown, never as released.
    expect((await runtime.getServeStats()).counts.workersByTerminalState).toEqual({
      ...ZERO_WORKER_TERMINAL_STATE_COUNTS,
      reclaimable: 1,
      retained: 1,
      release_unknown: 1
    })
    expect(handleOnly).not.toBe(reclaimable)
  })
})

function runtimeWithStubbedWorktrees(db: OrchestrationDb): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(null)
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'listManagedWorktrees').mockResolvedValue({
    worktrees: [],
    totalCount: 0,
    truncated: false
  })
  return runtime
}

// Every Task belongs to a Run; these cases only need the one coordinator Run to hang rows off.
function seedRun(db: OrchestrationDb): string {
  return db.createRun({
    objective: 'serve stats',
    coordinatorHandle: 'term_c',
    coordinatorPaneKey: 'tab_c:leaf_c'
  }).id
}

/**
 * Replays a start that created a terminal and then failed: with `adopt`, the dispatch keeps an
 * owned resource (reclaimable); without it, only the handle survives (retained).
 */
function seedFailedWorkerTerminal(
  db: OrchestrationDb,
  runId: string,
  handle: string,
  adopt: boolean
): string {
  const task = db.createTask({ spec: `worker for ${handle}`, runId })
  const started = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: task.id,
    startOptions: {}
  })
  const effects = [
    { kind: 'terminal', role: 'agent', action: 'created', id: handle, surface: 'visible' }
  ]
  db.recordWorkerStage({
    dispatchId: started.dispatch.id,
    stage: 'terminal_readying',
    worktreeId: 'repo::worktree',
    terminalHandle: handle,
    effects,
    residualResources: effects
  })
  if (adopt) {
    db.createWorkerTerminalResourceStatement({
      dispatchId: started.dispatch.id,
      terminalHandle: handle,
      worktreeId: 'repo::worktree',
      paneKey: `tab_${handle}:leaf_${handle}`,
      processIncarnation: `runtime:pty-${handle}:1`,
      hostScope: null,
      ownership: 'owned'
    })
  }
  db.failWorkerStart(started.dispatch.id, 'agent_readiness', 'Agent startup blocked')
  return started.dispatch.id
}

function attachBrowserHost(runtime: OrcaRuntimeService, browserHostClientId: string) {
  return getBrowserHostLeaseRegistry(runtime).attach({
    browserHostClientId,
    connectionId: `connection-${browserHostClientId}`,
    pairedDeviceId: `device-${browserHostClientId}`,
    hostCapabilities: ['webview']
  })
}

/**
 * Gives the runtime a real AgentBrowserBridge over a BrowserManager whose page-id registration map
 * is `registeredPages` — the map both browser backends write through, and the runtime's only view
 * of the pages a WebContents in this process backs.
 */
function installBrowserBridge(
  runtime: OrcaRuntimeService,
  registeredPages: Map<string, number>
): void {
  // The field is protected on the runtime; tests here already reach internals the same way.
  const internals = runtime as unknown as { agentBrowserBridge: AgentBrowserBridge }
  internals.agentBrowserBridge = new AgentBrowserBridge(mockBrowserManager(registeredPages))
}

function publishClientPage(
  runtime: OrcaRuntimeService,
  browserPageId: string,
  placement: RuntimeBrowserPlacement
): void {
  if (placement.kind !== 'client') {
    throw new Error('expected client placement')
  }
  getRuntimeBrowserPageRegistry(runtime).publishClientPage({
    browserPageId,
    workspaceId: 'workspace-a',
    browserProfileId: 'profile-a',
    executionHostKey: 'native:runtime-a:1',
    placement,
    url: 'https://example.internal/',
    loading: false,
    active: false
  })
}
