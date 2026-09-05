import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_HANDLERS } from '../../../../../../cli/handlers/orchestration'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

type WorkerListReceipt = {
  workers: { dispatchId: string; runId: string }[]
  scope: { run?: string; source: string }
}

/** Drives the real CLI handler against the real orchestration RPC surface and a real
 *  OrchestrationDb, so the bound Run is resolved the way `check` resolves it. */
describe('orchestration worker-list Run scope', () => {
  const h = createOrchestrationWorkerReleaseHarness()
  const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE
  let logged: string[]

  beforeEach(() => {
    h.setup()
    logged = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logged.push(line)
    })
  })

  afterEach(() => {
    h.cleanup()
    if (originalTerminalHandle === undefined) {
      delete process.env.ORCA_TERMINAL_HANDLE
    } else {
      process.env.ORCA_TERMINAL_HANDLE = originalTerminalHandle
    }
  })

  /** The real RPC surface over a real OrchestrationDb, so the bound Run is resolved by the same
   *  `orchestration.runCurrent` path `check` uses rather than by a stubbed flag reader. */
  const client = {
    call: async (name: string, params: Record<string, unknown>) => ({
      result: await h.call(name, params)
    })
  }

  function createDispatchInRun(runId: string, handle: string): string {
    const task = h.db.createTask({ spec: `task for ${handle}`, runId })
    return createRootDispatch(h.db, task.id, handle).id
  }

  async function listWorkers(
    flags = new Map<string, string | boolean>()
  ): Promise<WorkerListReceipt> {
    await ORCHESTRATION_HANDLERS['orchestration worker-list']({
      flags,
      client,
      cwd: '/tmp/repo',
      json: true
    } as never)
    return JSON.parse(logged.at(-1)!).result as WorkerListReceipt
  }

  it('defaults an unscoped list to the Run bound to the calling terminal', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_coord'
    const boundDispatch = createDispatchInRun(h.activeRunId, 'term_bound')
    const otherRun = h.db.createRun({
      objective: 'Another Run',
      coordinatorHandle: 'term_other',
      coordinatorPaneKey: 'tab_other:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    }).id
    const otherDispatch = createDispatchInRun(otherRun, 'term_unbound')

    const receipt = await listWorkers()

    expect(receipt.scope).toEqual({ run: h.activeRunId, source: 'bound' })
    expect(receipt.workers.map((worker) => worker.dispatchId)).toEqual([boundDispatch])
    expect(receipt.workers.map((worker) => worker.dispatchId)).not.toContain(otherDispatch)
  })

  it('keeps --run as the override over the terminal binding', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_coord'
    createDispatchInRun(h.activeRunId, 'term_bound')
    const otherRun = h.db.createRun({
      objective: 'Another Run',
      coordinatorHandle: 'term_other',
      coordinatorPaneKey: 'tab_other:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    }).id
    const otherDispatch = createDispatchInRun(otherRun, 'term_unbound')

    const receipt = await listWorkers(new Map<string, string | boolean>([['run', otherRun]]))

    expect(receipt.scope).toEqual({ run: otherRun, source: 'flag' })
    expect(receipt.workers.map((worker) => worker.dispatchId)).toEqual([otherDispatch])
  })

  it('still lists every Run when the caller has no bound Run', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_unbound_shell'
    const boundDispatch = createDispatchInRun(h.activeRunId, 'term_bound')
    const otherRun = h.db.createRun({
      objective: 'Another Run',
      coordinatorHandle: 'term_other',
      coordinatorPaneKey: 'tab_other:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    }).id
    const otherDispatch = createDispatchInRun(otherRun, 'term_unbound')

    const receipt = await listWorkers()

    expect(receipt.scope).toEqual({ source: 'all' })
    expect(receipt.workers.map((worker) => worker.dispatchId).sort()).toEqual(
      [boundDispatch, otherDispatch].sort()
    )
  })

  it('names the scope in the human-readable receipt', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_coord'
    createDispatchInRun(h.activeRunId, 'term_bound')

    await ORCHESTRATION_HANDLERS['orchestration worker-list']({
      flags: new Map(),
      client,
      cwd: '/tmp/repo',
      json: false
    } as never)

    expect(logged.at(-1)).toContain(`Scope: Run ${h.activeRunId} (bound to this terminal)`)
  })
})
