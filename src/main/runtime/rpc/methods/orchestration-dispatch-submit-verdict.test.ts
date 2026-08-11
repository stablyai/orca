import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'
import type { TerminalSubmitVerdict } from '../../../../shared/terminal-submit-verdict'

// Why: `injected: true` on a bare resolve told the coordinator a worker had picked up the task even
// when the preamble was still sitting in that worker's composer, unsubmitted.

const COORDINATOR = 'term_coordinator'
const WORKER = 'term_worker'

describe('orchestration.dispatch --inject submit verdict', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let runId: string

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => `tab:${handle}`)
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation(
      (handle) => `${handle}:process`
    )
    vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation(
      (handle) =>
        ({
          paneKey: `tab:${handle}`,
          processIncarnation: `${handle}:process`,
          launchTokenHash: undefined,
          connectionId: null
        }) as never
    )
    runId = db.createRun({
      objective: 'Report honest injection',
      coordinatorHandle: COORDINATOR,
      coordinatorPaneKey: `tab:${COORDINATOR}`
    }).id
  })

  afterEach(() => db.close())

  it('reports injected only when the preamble reached the worker turn', async () => {
    stubSend({ status: 'submitted', reason: 'turn-start-observed', waitedMs: 12 })

    const result = await dispatch()

    expect(result.injected).toBe(true)
    expect(result.submitVerdict).toMatchObject({ status: 'submitted' })
  })

  it.each([
    ['pending', 'no-turn-start-observed'],
    ['unknown', 'no-live-hook-evidence'],
    ['queued', 'accepted-mid-turn']
  ] as const)('does not report injected on a %s verdict', async (status, reason) => {
    stubSend({ status, reason, waitedMs: 2_500 })

    const result = await dispatch()

    expect(result.injected).toBe(false)
    expect(result.submitVerdict).toMatchObject({ status, reason })
    // Why: the bytes are in the pane and may still become a turn, so the context stays on the books
    // for the caller to resolve — it is just not reported as delivered work.
    expect(db.getDispatchContextById(result.dispatch!.id)).toMatchObject({ status: 'dispatched' })
  })

  it('does not report injected when the host answers with no verdict at all', async () => {
    stubSend(undefined)

    const result = await dispatch()

    expect(result.injected).toBe(false)
    expect(result.submitVerdict).toBeUndefined()
  })

  it('asks the send path for a verdict', async () => {
    const send = stubSend({ status: 'submitted', reason: 'turn-start-observed', waitedMs: 1 })

    await dispatch()

    expect(send).toHaveBeenCalledWith(WORKER, expect.any(String), { submitVerdict: {} })
  })

  function stubSend(submitVerdict: TerminalSubmitVerdict | undefined) {
    return vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: WORKER,
      accepted: true,
      bytesWritten: 42,
      ...(submitVerdict ? { submitVerdict } : {})
    })
  }

  async function dispatch(): Promise<{
    dispatch: { id: string } | null
    injected?: boolean
    submitVerdict?: TerminalSubmitVerdict
  }> {
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.dispatch'
    )!
    return (await method.handler(
      method.params!.parse({
        task: db.createTask({ spec: 'do the work', runId }).id,
        run: runId,
        from: COORDINATOR,
        to: WORKER,
        inject: true
      }),
      { runtime } as never
    )) as never
  }
})
