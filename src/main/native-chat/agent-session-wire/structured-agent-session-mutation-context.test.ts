import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as reducer from '../agent-session-journal/journal-reducer'
import { DISPATCH_DOUBT_SUBMISSION_MISSING } from '../agent-session-journal/journal-dispatch-doubt-reasons'
import { sendStructuredAgentSessionTurn } from './structured-agent-session-host-mutations'
import { mutateStructuredAgentSession } from './structured-agent-session-mutation-context'
import { sendPlan } from './structured-agent-session-mutation-plans'
import { runStructuredCompaction } from './structured-conversation-compaction'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'

let rig: QueuedMessageTestRig
beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rig.dispose()
})

function params(delivery?: 'queue-if-active') {
  const body = hostTestMessage('accepted once')
  const fields = { body, ...(delivery ? { delivery } : {}) }
  return { ...fields, envelope: rig.envelope(fields, 'agentSession.send', hostTestOperationId()) }
}

function context() {
  return { ...rig.host['mutationContext'](), wakeDelivery: vi.fn() }
}

it('wakes once for a direct send and never for its receipt replay', async () => {
  const ctx = context()
  const request = params()
  expect(await sendStructuredAgentSessionTurn(ctx, CALLER, request)).toMatchObject({
    ok: true,
    replayed: false
  })
  expect(ctx.wakeDelivery).toHaveBeenCalledExactlyOnceWith(SESSION)
  expect(await sendStructuredAgentSessionTurn(ctx, CALLER, request)).toMatchObject({
    ok: true,
    replayed: true
  })
  expect(ctx.wakeDelivery).toHaveBeenCalledOnce()
  expect(rig.host['sessions'].get(SESSION)?.journal.submissions()).toHaveLength(1)
})

it('does not wake for a queued draft or its replay', async () => {
  await rig.workingSend()
  const ctx = context()
  const request = params('queue-if-active')
  const accepted = await sendStructuredAgentSessionTurn(ctx, CALLER, request)
  expect(accepted).toMatchObject({
    ok: true,
    replayed: false,
    value: { queued: { state: 'waiting' } }
  })
  const replay = await sendStructuredAgentSessionTurn(ctx, CALLER, request)
  expect(replay).toMatchObject({ ok: true, replayed: true })
  if (!accepted.ok || !replay.ok) {
    throw new Error('expected accepted drafts')
  }
  expect(replay.value).toEqual(accepted.value)
  expect(ctx.wakeDelivery).not.toHaveBeenCalled()
})

it('wakes once after a direct send commits even when publication fails', async () => {
  const ctx = context()
  const request = params()
  const error = new Error('listener failed after commit')
  rig.host['sessions'].get(SESSION)?.journal.observeCommits(
    vi.fn().mockImplementationOnce(() => {
      throw error
    })
  )
  const warn = vi.spyOn(ctx.deps.logger, 'warn')
  expect(await sendStructuredAgentSessionTurn(ctx, CALLER, request)).toMatchObject({
    ok: true,
    replayed: true
  })
  expect(ctx.wakeDelivery).toHaveBeenCalledExactlyOnceWith(SESSION)
  expect(warn).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ scope: 'send-journal-write', error })
  )
  expect(warn).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      scope: 'command-receipt-publication',
      refusal: 'agent_session_operation_invalid'
    })
  )
})

it('replays a queued draft after publication fails without waking delivery', async () => {
  await rig.workingSend()
  const ctx = context()
  const request = params('queue-if-active')
  rig.host['sessions'].get(SESSION)?.journal.observeCommits(
    vi.fn().mockImplementationOnce(() => {
      throw new Error('draft publication failed')
    })
  )
  const accepted = await sendStructuredAgentSessionTurn(ctx, CALLER, request)
  const replay = await sendStructuredAgentSessionTurn(ctx, CALLER, request)
  expect(accepted).toMatchObject({
    ok: true,
    replayed: true,
    value: { queued: { state: 'waiting' } }
  })
  if (!accepted.ok || !replay.ok) {
    throw new Error('expected accepted drafts')
  }
  expect(replay.value).toEqual(accepted.value)
  expect(ctx.wakeDelivery).not.toHaveBeenCalled()
})

it('answers the same doubt on the first reply and resend when the committed row cannot fold', async () => {
  const ctx = context()
  const request = params()
  const fold = reducer.applyJournalRow
  vi.spyOn(reducer, 'applyJournalRow').mockImplementation((state, row) => {
    if (row.kind === 'submission') {
      throw new Error('submission fold failed')
    }
    fold(state, row)
  })
  const journal = rig.host['sessions'].get(SESSION)!.journal
  const append = vi.spyOn(journal, 'appendSubmission')
  const accepted = await sendStructuredAgentSessionTurn(ctx, CALLER, request)
  const replay = await sendStructuredAgentSessionTurn(ctx, CALLER, request)
  expect(accepted).toMatchObject({
    ok: true,
    replayed: true,
    value: {
      submission: {
        dispatchState: 'unknown',
        reason: DISPATCH_DOUBT_SUBMISSION_MISSING,
        recovered: true
      }
    }
  })
  expect(replay).toEqual(accepted)
  expect(journal.submissions()).toHaveLength(0)
  expect(
    rig.store.readCommandReceipt({ kind: 'global' }, request.envelope.clientOperationId)
  ).toMatchObject({ verdict: 'readable', receipt: { status: 'accepted' } })
  expect(append).toHaveBeenCalledOnce()
  expect(ctx.wakeDelivery).toHaveBeenCalledOnce()
})

it('logs a throw after commit and wakes once before answering from receipt replay', async () => {
  const ctx = context()
  const request = params()
  const plan = sendPlan(request)
  const error = new Error('plan publication failed')
  const warn = vi.spyOn(ctx.deps.logger, 'warn')
  const accepted = await mutateStructuredAgentSession(ctx, CALLER, request.envelope, {
    ...plan,
    run: async (turn) => {
      await plan.run(turn)
      throw error
    }
  })
  expect(accepted).toMatchObject({
    ok: true,
    replayed: true,
    value: { submission: { dispatchState: 'pending' } }
  })
  expect(warn).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ scope: 'command-receipt-publication', error })
  )
  expect(ctx.wakeDelivery).toHaveBeenCalledOnce()
})

it('logs a wake error and still answers accepted', async () => {
  const ctx = context()
  const error = new Error('wake failed')
  ctx.wakeDelivery.mockImplementation(() => {
    throw error
  })
  const warn = vi.spyOn(ctx.deps.logger, 'warn')
  expect(await sendStructuredAgentSessionTurn(ctx, CALLER, params())).toMatchObject({ ok: true })
  expect(ctx.wakeDelivery).toHaveBeenCalledOnce()
  expect(warn).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ scope: 'command-receipt-delivery', error })
  )
})

it('logs a receipt read error and refuses unknown without accepting or waking', async () => {
  const ctx = context()
  const request = params()
  const error = new Error('receipt read failed')
  const warn = vi.spyOn(ctx.deps.logger, 'warn')
  vi.spyOn(rig.store, 'readCommandReceipt').mockImplementationOnce(() => {
    throw error
  })
  expect(await sendStructuredAgentSessionTurn(ctx, CALLER, request)).toMatchObject({
    ok: false,
    refusal: { code: 'agent_session_operation_unknown', details: { reason: 'outcomeUnknown' } }
  })
  expect(warn).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      scope: 'command-receipt-read',
      operationId: request.envelope.clientOperationId,
      error
    })
  )
  expect(rig.host['sessions'].get(SESSION)?.journal.submissions()).toHaveLength(0)
  expect(ctx.wakeDelivery).not.toHaveBeenCalled()
})

it('wakes once for /compact and never for its replay', async () => {
  const ctx = context()
  const fields = { command: 'compact' as const }
  const request = {
    ...fields,
    envelope: rig.envelope(fields, 'agentSession.conversationCommand', hostTestOperationId())
  }
  const host = { waitForSendSettlement: vi.fn(async () => undefined) }
  expect(await runStructuredCompaction(ctx, host, CALLER, request)).toMatchObject({
    ok: true,
    replayed: false
  })
  expect(ctx.wakeDelivery).toHaveBeenCalledExactlyOnceWith(SESSION)
  expect(
    await runStructuredCompaction(ctx, host, { callerKey: 'second-caller' }, request)
  ).toMatchObject({ ok: true, replayed: true })
  expect(ctx.wakeDelivery).toHaveBeenCalledOnce()
})
