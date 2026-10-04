import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../../core'
import type { OrchestrationDb, RunRow } from '../../../../orchestration/db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { DispatchContextRow } from '../../../../orchestration/types'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'

// A lead is dispatched by a root coordinator and then coordinates its own Run from the same pane.
// That pane's `check` reads its own Run mailbox, so mail meant for it must land there.
describe('mail for a lead whose pane coordinates its own Run', () => {
  const h = createOrchestrationRpcHarness()
  const coordPane = 'tab_coord:11111111-1111-4111-8111-111111111111'
  const leadPane = 'tab_lead:22222222-2222-4222-9222-222222222222'
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let rootRun: RunRow
  let dispatch: DispatchContextRow

  afterEach(() => {
    h.cleanup()
  })

  function setup(): void {
    ;({ db, runtime, ctx } = h.setup(false))
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? coordPane : handle === 'term_lead' ? leadPane : null
    )
    rootRun = db.createRun({
      objective: 'root',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: coordPane
    })
    const task = db.createTask({ spec: 'lead the sub-project', runId: rootRun.id })
    dispatch = createRootDispatch(db, task.id, 'term_lead', leadPane)
  }

  function bindLeadRun(): RunRow {
    return db.createRun({
      objective: 'lead',
      coordinatorHandle: 'term_lead',
      coordinatorPaneKey: leadPane
    })
  }

  async function call(name: string, params: Record<string, unknown>) {
    return h.call(name, params, ctx)
  }

  async function leadInbox(params: Record<string, unknown> = {}): Promise<unknown> {
    return call('orchestration.check', { terminal: 'term_lead', ...params })
  }

  function deliveryIdOf(result: unknown): string {
    if (
      typeof result === 'object' &&
      result !== null &&
      'deliveryId' in result &&
      typeof result.deliveryId === 'string'
    ) {
      return result.deliveryId
    }
    throw new Error('check returned no delivery')
  }

  it('routes dispatch:<id> mail to the Run the assignee pane now coordinates', async () => {
    setup()
    const leadRun = bindLeadRun()

    const result = await call('orchestration.send', {
      from: 'term_coord',
      to: `dispatch:${dispatch.id}`,
      subject: 'Follow-up for the lead'
    })

    expect(result).toMatchObject({
      message: { to_handle: `run:${leadRun.id}`, run_id: leadRun.id },
      warnings: [{ code: 'recipient_run_bound_redirect' }]
    })
    expect(await leadInbox()).toMatchObject({ messages: [{ subject: 'Follow-up for the lead' }] })
  })

  it('still reads dispatch mail that arrived before the pane bound its own Run', async () => {
    setup()
    db.insertMessage({
      from: 'term_coord',
      to: `dispatch:${dispatch.id}`,
      subject: 'Sent before the lead bound a Run',
      runId: rootRun.id
    })
    const leadRun = bindLeadRun()
    db.insertMessage({
      from: 'term_worker',
      to: `run:${leadRun.id}`,
      subject: 'Sub-worker report',
      runId: leadRun.id
    })

    const first = await leadInbox()
    expect(first).toMatchObject({ messages: [{ subject: 'Sent before the lead bound a Run' }] })

    const second = await leadInbox({ ack: deliveryIdOf(first) })
    expect(second).toMatchObject({ messages: [{ subject: 'Sub-worker report' }] })
  })

  it('keeps the --types wake condition when older Dispatch mail does not match it', async () => {
    setup()
    db.insertMessage({
      from: 'term_coord',
      to: `dispatch:${dispatch.id}`,
      subject: 'Older status note',
      type: 'status',
      runId: rootRun.id
    })
    const leadRun = bindLeadRun()
    db.insertMessage({
      from: 'term_worker',
      to: `run:${leadRun.id}`,
      subject: 'Sub-worker finished',
      type: 'worker_done',
      runId: leadRun.id
    })

    const woke = await leadInbox({ wait: true, types: 'worker_done', timeoutMs: 500 })

    expect(woke).toMatchObject({
      runId: leadRun.id,
      messages: [{ subject: 'Sub-worker finished' }]
    })
  })

  it('delivers a reply to a Run-bound sender and wakes its waiting check', async () => {
    setup()
    const leadRun = bindLeadRun()
    const report = db.insertMessage({
      from: 'term_lead',
      to: `run:${rootRun.id}`,
      subject: 'Lead report',
      runId: rootRun.id
    })

    const waiting = leadInbox({ wait: true, timeoutMs: 2_000 })
    const reply = await call('orchestration.reply', {
      id: report.id,
      from: 'term_coord',
      body: 'Decision'
    })

    expect(reply).toMatchObject({
      message: { to_handle: `run:${leadRun.id}`, run_id: leadRun.id }
    })
    expect(await waiting).toMatchObject({
      timedOut: false,
      messages: [{ subject: 'Re: Lead report' }]
    })
  })

  it('keeps dispatch:<id> mail on the Dispatch mailbox while the assignee has no Run', async () => {
    setup()

    const result = await call('orchestration.send', {
      from: 'term_coord',
      to: `dispatch:${dispatch.id}`,
      subject: 'Plain worker follow-up'
    })

    expect(result).toMatchObject({ message: { to_handle: `dispatch:${dispatch.id}` } })
    expect(result).not.toHaveProperty('warnings')
  })

  it('keeps a reply on the raw handle when the sender has no Run or live pane', async () => {
    setup()
    const note = db.insertMessage({
      from: 'term_offline',
      to: `run:${rootRun.id}`,
      subject: 'Offline note',
      runId: rootRun.id
    })

    const reply = await call('orchestration.reply', {
      id: note.id,
      from: 'term_coord',
      body: 'Ack'
    })

    expect(reply).toMatchObject({ message: { to_handle: 'term_offline', run_id: rootRun.id } })
  })
})
