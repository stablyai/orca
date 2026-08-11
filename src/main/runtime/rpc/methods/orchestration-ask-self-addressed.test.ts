import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import { RpcDispatcher } from '../dispatcher'
import type { RpcContext } from '../core'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'

const CAPTAIN_PANE = 'tab_captain:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const GENERAL_PANE = 'tab_general:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const WORKER_PANE = 'tab_worker:cccccccc-cccc-4ccc-8ccc-cccccccccccc'

describe('orchestration.ask self-addressed refusal', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext

  const paneByHandle: Record<string, string> = {
    term_captain: CAPTAIN_PANE,
    term_general: GENERAL_PANE,
    term_worker: WORKER_PANE
  }

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation(
      (handle) => paneByHandle[handle] ?? null
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation(
      (handle) => `runtime_test:${handle}:1`
    )
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    ctx = { runtime }
  }

  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
  })

  function createRun(coordinatorHandle: string): string {
    return db.createRun({
      objective: `Run for ${coordinatorHandle}`,
      coordinatorHandle,
      coordinatorPaneKey: paneByHandle[coordinatorHandle] as string
    }).id
  }

  function dispatchTo(runId: string, assigneeHandle: string): string {
    const task = db.createTask({ spec: 'question work', runId })
    return db.createDispatchContext(task.id, assigneeHandle, paneByHandle[assigneeHandle]).id
  }

  async function ask(params: Record<string, unknown>) {
    const method = ORCHESTRATION_METHODS.find((m) => m.name === 'orchestration.ask')
    if (!method) {
      throw new Error('orchestration.ask is not registered')
    }
    // Why: timeoutMs 0 makes the wait loop return immediately, so a legitimate ask
    // resolves without a message-arrival fixture.
    return method.handler(method.params?.parse({ timeoutMs: 0, ...params }), ctx)
  }

  function questionMessages(runId: string) {
    return db
      .getInbox(100)
      .filter((message) => message.type === 'question' && message.run_id === runId)
  }

  it('refuses when the asker coordinates the Run its Dispatch belongs to', async () => {
    setup()
    const runId = createRun('term_captain')
    const dispatchId = dispatchTo(runId, 'term_captain')

    await expect(ask({ from: 'term_captain', question: 'proceed?' })).rejects.toMatchObject({
      code: 'ask_self_addressed',
      message: expect.stringContaining(`orchestration send --to run:${runId}`),
      data: { effectsApplied: false }
    })
    expect(questionMessages(runId)).toHaveLength(0)
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
  })

  it('refuses to resume a Question whose Run the asker has since taken over', async () => {
    setup()
    const runId = createRun('term_general')
    const dispatchId = dispatchTo(runId, 'term_captain')
    const created = db.createQuestion({
      runId,
      dispatchId,
      askerHandle: 'term_captain',
      question: 'proceed?'
    })
    db.bindRun({
      runId,
      coordinatorHandle: 'term_captain',
      coordinatorPaneKey: CAPTAIN_PANE
    })

    await expect(
      ask({ from: 'term_captain', resume: created.question.message_id })
    ).rejects.toMatchObject({ code: 'ask_self_addressed' })
  })

  it('reports the refusal as a typed RPC error code', async () => {
    setup()
    const runId = createRun('term_captain')
    dispatchTo(runId, 'term_captain')

    const response = await new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS }).dispatch({
      id: 'req_1',
      authToken: 'token',
      method: 'orchestration.ask',
      params: { from: 'term_captain', question: 'proceed?', timeoutMs: 0 },
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION
    })

    expect(response).toMatchObject({ ok: false, error: { code: 'ask_self_addressed' } })
  })

  it('allows a nested coordinator to ask the Run that dispatched it', async () => {
    setup()
    const parentRunId = createRun('term_general')
    dispatchTo(parentRunId, 'term_captain')
    // The nested coordinator owns its own Run; only the parent Run's inbox is asked.
    const childRunId = createRun('term_captain')

    await expect(ask({ from: 'term_captain', question: 'proceed?' })).resolves.toMatchObject({
      timedOut: true
    })
    expect(questionMessages(parentRunId)).toMatchObject([{ to_handle: `run:${parentRunId}` }])
    expect(questionMessages(childRunId)).toHaveLength(0)
  })

  it('allows a dispatched worker that coordinates no Run', async () => {
    setup()
    const runId = createRun('term_general')
    dispatchTo(runId, 'term_worker')

    await expect(ask({ from: 'term_worker', question: 'proceed?' })).resolves.toMatchObject({
      timedOut: true
    })
    expect(questionMessages(runId)).toMatchObject([{ to_handle: `run:${runId}` }])
  })

  // Why: the guard must not shadow a more specific error — an invalid request has to report
  // what is wrong with the request, not that the caller happens to coordinate its own Run.
  it('reports a resume id from another Dispatch as question_not_found', async () => {
    setup()
    const runId = createRun('term_captain')
    dispatchTo(runId, 'term_captain')
    const otherRunId = createRun('term_general')
    const otherDispatchId = dispatchTo(otherRunId, 'term_worker')
    const foreign = db.createQuestion({
      runId: otherRunId,
      dispatchId: otherDispatchId,
      askerHandle: 'term_worker',
      question: 'not yours'
    })

    await expect(
      ask({ from: 'term_captain', resume: foreign.question.message_id })
    ).rejects.toMatchObject({ code: 'question_not_found' })
  })

  it('reports an explicit Run target that is not the caller Dispatch Run as dispatch_run_mismatch', async () => {
    setup()
    const runId = createRun('term_captain')
    dispatchTo(runId, 'term_captain')
    const otherRunId = createRun('term_general')

    await expect(
      ask({ from: 'term_captain', question: 'proceed?', run: otherRunId })
    ).rejects.toMatchObject({ code: 'dispatch_run_mismatch' })
    await expect(
      ask({ from: 'term_captain', question: 'proceed?', to: `run:${otherRunId}` })
    ).rejects.toMatchObject({ code: 'dispatch_run_mismatch' })
    expect(questionMessages(runId)).toHaveLength(0)
  })

  // Why: resume takes the same explicit targets as a fresh ask, so ignoring them would let a
  // caller wait on a Question filed under a Run it did not name.
  it('reports a mismatched explicit target on a resumed Question as dispatch_run_mismatch', async () => {
    setup()
    const runId = createRun('term_general')
    const dispatchId = dispatchTo(runId, 'term_worker')
    const owned = db.createQuestion({
      runId,
      dispatchId,
      askerHandle: 'term_worker',
      question: 'proceed?'
    })
    const foreignRunId = createRun('term_captain')

    await expect(
      ask({ from: 'term_worker', resume: owned.question.message_id, run: foreignRunId })
    ).rejects.toMatchObject({ code: 'dispatch_run_mismatch' })
    await expect(
      ask({ from: 'term_worker', resume: owned.question.message_id, to: `run:${foreignRunId}` })
    ).rejects.toMatchObject({ code: 'dispatch_run_mismatch' })
    await expect(
      ask({ from: 'term_worker', resume: owned.question.message_id, to: 'term_captain' })
    ).rejects.toMatchObject({ code: 'dispatch_run_mismatch' })
  })

  it('accepts an explicit target that agrees with the resumed Question owning Run', async () => {
    setup()
    const runId = createRun('term_general')
    const dispatchId = dispatchTo(runId, 'term_worker')
    const owned = db.createQuestion({
      runId,
      dispatchId,
      askerHandle: 'term_worker',
      question: 'proceed?'
    })

    await expect(
      ask({ from: 'term_worker', resume: owned.question.message_id, run: runId })
    ).resolves.toMatchObject({ timedOut: true })
    await expect(
      ask({ from: 'term_worker', resume: owned.question.message_id, to: `run:${runId}` })
    ).resolves.toMatchObject({ timedOut: true })
    await expect(
      ask({ from: 'term_worker', resume: owned.question.message_id, to: 'term_general' })
    ).resolves.toMatchObject({ timedOut: true })
    // Resume must not create a second Question for the same thread.
    expect(questionMessages(runId)).toHaveLength(1)
  })

  it('leaves the undispatched coordinator error unchanged', async () => {
    setup()
    createRun('term_captain')

    await expect(ask({ from: 'term_captain', question: 'proceed?' })).rejects.toMatchObject({
      code: 'dispatch_inactive'
    })
  })
})
