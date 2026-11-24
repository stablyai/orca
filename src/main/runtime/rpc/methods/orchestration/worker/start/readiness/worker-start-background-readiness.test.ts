import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../../../orca-runtime'
import { OrchestrationDb } from '../../../../../../orchestration/db/orchestration-db'
import '../../../../../../orchestration/db/contract-constants'
import '../../../../../../orchestration/db/messages/mailbox-routing-page'
import '../../../../../../orchestration/db/dispatch-row-writer'
import '../../../../../../orchestration/db/attempt-outcome-projection'
import {
  awaitWorkerAgentInBackground,
  type AwaitingWorkerStart
} from './worker-start-background-readiness'

vi.mock('../../../../../../orchestration/workers/turn-stops/awaiting-worker-start-report', () => ({
  reportBlockedWorkerStart: vi.fn(async () => {}),
  reportNeverReadyWorkerStart: vi.fn(),
  readWorkerStartScreen: vi.fn(async () => '')
}))
vi.mock('../../../../../../terminal/wait/launched-agent-composer-readiness', () => ({
  freshLaunchPtyId: () => null,
  waitForWorkerAgentReady: vi.fn(async () => ({ satisfied: true }))
}))

const cleanups: (() => void)[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

const SETUP: AwaitingWorkerStart['setup'] = {
  requested: 'not_applicable',
  effective: 'not_applicable',
  source: 'none',
  hookFound: false,
  startupPolicy: 'start-immediately',
  state: 'not_applicable'
}

/** A pane showing a startup prompt: `cleared` says when it reads as gone; `repaint` draws once. */
function promptPane(cleared: () => boolean) {
  let repaint: (() => void) | undefined
  const runtime = {
    getTerminalPtyIdForHandle: () => 'pty-1',
    subscribeToTerminalData: (_pty: string, listener: () => void) => {
      repaint = listener
      return () => {}
    },
    waitForTerminal: (_handle: string, options: { condition: string }) =>
      options.condition === 'exit'
        ? new Promise(() => {})
        : Promise.resolve(
            cleared()
              ? { satisfied: true }
              : { satisfied: false, blockedReason: 'codex-trust-workspace' }
          ),
    notifyMessageArrived: () => {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wait reads only the terminal methods faked above.
  return { runtime: runtime as unknown as OrcaRuntimeService, repaint: () => repaint?.() }
}

/** A worker whose startup prompt the person answers at `answeredAt`: the pane repaints once, then
 *  stays quiet, and the stale prompt reads as gone only after 3 s of that quiet. */
function answeredPromptWorker(answeredAt: number) {
  const pane = promptPane(() => Date.now() >= answeredAt + 3000)
  let stage = 'starting'
  const db = {
    recordWorkerStage: ({ stage: next }: { stage: string }) => {
      stage = next
    },
    getWorkerDispatch: () => ({ state: 'starting', stage }),
    failWorkerStart: vi.fn()
  }
  const handOver = vi.fn(async () => {})
  awaitWorkerAgentInBackground({
    runtime: pane.runtime,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wait reads only the dispatch methods faked above.
    db: db as unknown as OrchestrationDb,
    dispatchId: 'ctx_1',
    terminalHandle: 'term_1',
    readiness: { agent: 'codex', reusesTerminal: false },
    setup: SETUP,
    launchedAt: Date.now(),
    blockedReason: 'codex-trust-workspace',
    handOver,
    bindTerminal: () => {},
    fail: vi.fn(async () => {})
  })
  return { handOver, db, repaint: pane.repaint }
}

/** A real Dispatch whose created terminal is in its custody, as placement leaves it. */
function startingDispatch(liveIncarnation?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-never-ready-'))
  const db = new OrchestrationDb(join(directory, 'orchestration.db'))
  cleanups.push(() => {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const runId = db.createRun({
    objective: 'start',
    coordinatorHandle: null,
    coordinatorPaneKey: null
  }).id
  const task = db.createTask({ runId, spec: 'slow agent' })
  const { dispatch } = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: task.id,
    startOptions: {}
  })
  const identity = {
    handle: 'term_1',
    paneKey: 'tab_1:leaf',
    processIncarnation: 'pty-live:22222222-2222-4222-8222-222222222222'
  }
  db.recordCreatedWorkerTerminalCustody({
    dispatchId: dispatch.id,
    ...identity,
    worktreeId: 'wt-1'
  })
  const bindTerminal = () =>
    db.prepareStartingWorkerAuthority({
      dispatchId: dispatch.id,
      ...identity,
      processIncarnation: liveIncarnation ?? identity.processIncarnation,
      worktreeId: 'wt-1',
      setupState: 'not_applicable',
      effects: [],
      terminalOwnership: 'created'
    })
  return { db, dispatchId: dispatch.id, identity, bindTerminal }
}

describe('a worker start waiting on a startup prompt', () => {
  it('types the brief once the answered prompt clears, with no further output', async () => {
    vi.useFakeTimers()
    const worker = answeredPromptWorker(Date.now() + 1000)
    await vi.advanceTimersByTimeAsync(1000)
    worker.repaint()
    await vi.advanceTimersByTimeAsync(5000)
    expect(worker.handOver).toHaveBeenCalledTimes(1)
    expect(worker.db.failWorkerStart).not.toHaveBeenCalled()
  })

  /** Runs a start whose prompt never clears past its 10-minute deadline. */
  async function neverReady(liveIncarnation?: string) {
    vi.useFakeTimers()
    const started = startingDispatch(liveIncarnation)
    const { db, dispatchId, identity, bindTerminal } = started
    awaitWorkerAgentInBackground({
      runtime: promptPane(() => false).runtime,
      db,
      dispatchId,
      terminalHandle: identity.handle,
      readiness: { agent: 'codex', reusesTerminal: false },
      setup: SETUP,
      launchedAt: Date.now(),
      blockedReason: 'codex-trust-workspace',
      handOver: vi.fn(async () => {}),
      bindTerminal,
      fail: vi.fn(async () => {})
    })
    await vi.advanceTimersByTimeAsync(11 * 60_000)
    return started
  }

  it('leaves a start that never got ready releasable: its open terminal is bound as its own', async () => {
    const { db, dispatchId, identity } = await neverReady()
    expect(db.getWorkerDispatch(dispatchId)).toMatchObject({
      state: 'failed',
      agent_terminal_handle: identity.handle
    })
    expect(db.isDispatchProcessCurrent({ dispatchId, ...identity })).toBe(true)
  })

  it('never binds a process that replaced the one the start created', async () => {
    const replaced = 'pty-live:33333333-3333-4333-8333-333333333333'
    const { db, dispatchId, identity } = await neverReady(replaced)
    expect(db.getWorkerDispatch(dispatchId)).toMatchObject({
      state: 'failed',
      agent_terminal_handle: null
    })
    expect(
      db.isDispatchProcessCurrent({ dispatchId, ...identity, processIncarnation: replaced })
    ).toBe(false)
  })
})
