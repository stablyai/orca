import { failedWorker } from './structured-chat-failed-worker.test-fixture'
import '../../../rpc/dispatch/testing/unused-default-rpc-methods.test-fixture'
import { expect, it } from 'vitest'
import { formatOrcaSessionAddress } from '../../../../../shared/agent-session/identity/orca-session-address'
import { testOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import {
  COORDINATOR,
  PEER_CHAT,
  call,
  db,
  dispatcher,
  host,
  request
} from './structured-chat-coordinator-mail-rig.test-fixture'

const workerAddress = formatOrcaSessionAddress(testOrcaSessionId(PEER_CHAT))

function failureId(receipt: Record<string, unknown>): string {
  if (typeof receipt.failureId !== 'string') {
    throw new Error('Missing observed failure id')
  }
  return receipt.failureId
}

it('returns a kept, typed negative delivery through the real RPC and preserves it on old-client completed-receipt replay', async () => {
  const { dispatchId } = await failedWorker()
  const sent = request(
    'orchestration.send',
    { to: `dispatch:${dispatchId}`, subject: 'kept instruction' },
    { sessionId: COORDINATOR }
  )
  const first = await dispatcher.dispatch(sent)
  expect(first).toMatchObject({
    ok: false,
    error: {
      code: 'recipient_delivery_held',
      data: {
        messageKept: true,
        delivered: false,
        state: 'held',
        reason: { kind: 'worker_failed', failure: 'network' },
        target: { sessionId: PEER_CHAT, dispatchId }
      }
    }
  })
  if (
    first.ok ||
    !first.error.data ||
    typeof first.error.data !== 'object' ||
    !('message' in first.error.data)
  ) {
    throw new Error('Missing kept message receipt')
  }
  const replay = await dispatcher.dispatch(sent)
  expect(replay).toMatchObject({
    ok: false,
    error: {
      code: 'recipient_delivery_held',
      data: {
        message: first.error.data.message,
        delivered: false,
        state: 'held'
      }
    }
  })
  expect(
    db
      .getUnreadMessages(`dispatch:${dispatchId}`)
      .filter((row) => row.subject === 'kept instruction')
      .map((row) => row.subject)
  ).toEqual(['kept instruction'])
})

it('permits only the current coordinator to consume the observed failure once, without duplicating the kept input', async () => {
  const { dispatchId } = await failedWorker()
  const held = await call(
    'orchestration.send',
    { to: `dispatch:${dispatchId}`, subject: 'keep this work', deliveryOutcome: true },
    { sessionId: COORDINATOR }
  )
  expect(held).toMatchObject({
    delivered: false,
    state: 'held',
    reason: { kind: 'worker_failed', failure: 'network' }
  })
  const token = failureId(held)
  const unauthorized = await dispatcher.dispatch(
    request(
      'orchestration.send',
      {
        from: workerAddress,
        to: `dispatch:${dispatchId}`,
        resume: true,
        expectedFailureId: token,
        deliveryOutcome: true
      },
      { sessionId: PEER_CHAT }
    )
  )
  expect(unauthorized).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  const resumed = await call(
    'orchestration.send',
    { to: `dispatch:${dispatchId}`, resume: true, expectedFailureId: token, deliveryOutcome: true },
    { sessionId: COORDINATOR }
  )
  expect(resumed).toMatchObject({
    delivered: false,
    state: 'resuming',
    recovery: { status: 'resumed' }
  })
  const again = await dispatcher.dispatch(
    request(
      'orchestration.send',
      {
        to: `dispatch:${dispatchId}`,
        resume: true,
        expectedFailureId: token,
        deliveryOutcome: true
      },
      { sessionId: COORDINATOR }
    )
  )
  expect(again).toMatchObject({ ok: false, error: { code: 'worker_resume_already-used' } })
  expect(
    db
      .getUnreadMessages(`dispatch:${dispatchId}`)
      .filter((row) => row.subject === 'keep this work')
      .map((row) => row.subject)
  ).toEqual(['keep this work'])
})

it('rejects a stale observed token before it can save a new message', async () => {
  const { dispatchId } = await failedWorker()
  const response = await dispatcher.dispatch(
    request(
      'orchestration.send',
      {
        to: `dispatch:${dispatchId}`,
        resume: true,
        expectedFailureId: '0'.repeat(64),
        subject: 'must not be kept',
        deliveryOutcome: true
      },
      { sessionId: COORDINATOR }
    )
  )
  expect(response).toMatchObject({
    ok: false,
    error: { code: 'worker_resume_stale-failure', data: { effectsApplied: false } }
  })
  expect(
    db
      .getUnreadMessages(`dispatch:${dispatchId}`)
      .filter((row) => row.subject === 'must not be kept')
  ).toEqual([])
  expect(await host.heldDelivery(PEER_CHAT)).toMatchObject({
    state: 'held',
    reason: { failure: 'network' }
  })
})
