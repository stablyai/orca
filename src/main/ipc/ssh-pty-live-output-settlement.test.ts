import { afterEach, expect, it, vi } from 'vitest'
import { SshPtySourceObligationLedger } from './ssh-pty-source-obligation-ledger'
import type {
  PtySourceDeliveryIdentity,
  PtySourceSpan
} from '../../shared/pty-source-credit-contract'
import {
  createSshPtyOutputIntakeHarness,
  sshPtyOutputEvent
} from './ssh-pty-output-intake-test-harness'
import {
  installSshPtyOutputIntake,
  requireSshPtyLiveSourceSettlement
} from './ssh-pty-output-intake-registry'

const identity: PtySourceDeliveryIdentity = {
  id: 'relay-1',
  providerGeneration: 1,
  clientGeneration: 2,
  ownerGeneration: 3,
  ptyIncarnation: 'incarnation-1',
  deliveryToken: 'token-1'
}
const span: PtySourceSpan = {
  ...identity,
  spanId: 'span-1',
  sourceStartSu: 0,
  sourceEndSu: 4,
  displayStart: 0,
  displayEnd: 4,
  data: 'data',
  splittable: true,
  transform: { transformed: false, rawLengthSu: 4, scalarSafe: true }
}
function fixture() {
  const ledger = new SshPtySourceObligationLedger()
  ledger.open(identity)
  ledger.commit(ledger.reserve(identity, span, ['model', 'desktop', 'ownership-transfer:bridge']))
  const requireSettled = () => ledger.requireLiveSettlement(identity, 4)
  const settleAll = () => {
    for (const consumer of ['model', 'desktop', 'ownership-transfer:bridge'] as const) {
      ledger.settle(span.spanId, consumer, 'accepted')
    }
    return ledger.queueAck(identity)!
  }
  return { ledger, requireSettled, settleAll }
}

afterEach(() => vi.useRealTimers())

it('requires every consumer and a successful ACK write, not model acceptance or ACK queueing', () => {
  const f = fixture()
  f.ledger.settle(span.spanId, 'model', 'accepted')
  expect(f.ledger.modelAcceptedEnd(identity)).toBe(4)
  expect(f.requireSettled).toThrow('settlement_unavailable')
  f.ledger.settle(span.spanId, 'desktop', 'accepted')
  expect(f.requireSettled).toThrow('settlement_unavailable')
  const ack = f.settleAll()
  expect(f.requireSettled).toThrow('settlement_unavailable')
  ack.onSettled({ ok: false, error: new Error('write lost') })
  expect(f.requireSettled).toThrow('settlement_unavailable')
  f.ledger.retryQueuedAck(identity)!.onSettled({ ok: true })
  expect(f.requireSettled()).toEqual({ ...identity, fromSourceEndSu: 0, throughSourceEndSu: 4 })
  expect(f.ledger.snapshot(identity)).toMatchObject({ state: 'active', exitPublished: false })
})

it('remembers canceled consumers even after their ACK reclaims all spans', () => {
  const f = fixture()
  f.ledger.beginTransfer(span.spanId, 'desktop', 'remote:viewer', 'handoff')
  f.ledger.cancelTransfer(span.spanId, 'desktop', 'viewer disappeared')
  f.settleAll().onSettled({ ok: true })
  expect(f.ledger.snapshot(identity)).toMatchObject({ openSpans: 0, ackPublishedEndSu: 4 })
  expect(f.requireSettled).toThrow('settlement_unavailable')
})

it('accepts committed consumer transfer but not an unfinished or rolled-back transfer', () => {
  const f = fixture()
  f.ledger.beginTransfer(span.spanId, 'desktop', 'remote:viewer', 'handoff')
  f.settleAll()
  expect(f.requireSettled).toThrow('settlement_unavailable')
  f.ledger.rollbackTransfer(span.spanId, 'desktop')
  expect(f.requireSettled).toThrow('settlement_unavailable')
  f.ledger.beginTransfer(span.spanId, 'desktop', 'remote:viewer', 'handoff')
  f.ledger.commitTransfer(span.spanId, 'desktop')
  f.ledger.queueAck(identity)!.onSettled({ ok: true })
  expect(f.requireSettled().throughSourceEndSu).toBe(4)
})

it('refuses a pending admission and permits retry only after rollback', () => {
  const f = fixture()
  f.settleAll().onSettled({ ok: true })
  const pending = f.ledger.reserve(
    identity,
    {
      ...span,
      spanId: 'span-2',
      sourceStartSu: 4,
      sourceEndSu: 8,
      displayStart: 4,
      displayEnd: 8
    },
    ['model']
  )
  expect(f.requireSettled).toThrow('admission_pending')
  f.ledger.rollback(pending)
  expect(f.requireSettled().throughSourceEndSu).toBe(4)
})

it.each([
  { id: 'other' },
  { providerGeneration: 99 },
  { clientGeneration: 99 },
  { ownerGeneration: 99 },
  { ptyIncarnation: 'other' },
  { deliveryToken: 'other' }
])('rejects changed delivery identity %j', (change) => {
  const f = fixture()
  f.settleAll().onSettled({ ok: true })
  expect(() => f.ledger.requireLiveSettlement({ ...identity, ...change }, 4)).toThrow()
})

it.each(['seal', 'close'] as const)('does not treat %s as non-exit settlement', (action) => {
  const f = fixture()
  f.settleAll().onSettled({ ok: true })
  if (action === 'seal') {
    f.ledger.seal(identity)
  } else {
    f.ledger.closeGeneration(1, 'disconnected')
  }
  expect(f.requireSettled).toThrow()
})

it('reports only the locally observed interval and rejects stale or invalid endpoints', () => {
  const ledger = new SshPtySourceObligationLedger()
  ledger.open(identity, 100)
  expect(ledger.requireLiveSettlement(identity, 100)).toMatchObject({
    fromSourceEndSu: 100,
    throughSourceEndSu: 100
  })
  for (const end of [-1, 0, 101, Number.NaN, Infinity]) {
    expect(() => ledger.requireLiveSettlement(identity, end)).toThrow()
  }
})

it('joins the installed intake with exact app identity and refuses missing or replaced evidence', async () => {
  vi.useFakeTimers()
  const f = createSshPtyOutputIntakeHarness({
    publishSourceAck: (_generation, _batch, settle) => settle({ ok: true })
  })
  const uninstall = installSshPtyOutputIntake(f.intake)
  try {
    const pending = f.intake.acceptData(
      sshPtyOutputEvent({
        source: {
          relayPtyId: identity.id,
          spanId: span.spanId,
          clientGeneration: 2,
          ownerGeneration: 3,
          deliveryToken: 'token-1',
          sourceStartSu: 0,
          sourceEndSu: 4
        }
      })
    )
    f.completions[0].resolve()
    const receipt = await pending
    const checkpoint = f.intake.getAcceptedSourceCheckpoints(1)[0]
    expect(() => requireSshPtyLiveSourceSettlement(checkpoint)).toThrow()
    f.intake.publishProjectionPrefix([receipt.projection.identity.projectionSemanticsId], 4, 4)
    f.intake.settleProjectionPrefix('pty-1', 4)
    await vi.advanceTimersByTimeAsync(8)
    expect(requireSshPtyLiveSourceSettlement(checkpoint)).toEqual({
      ...identity,
      fromSourceEndSu: 0,
      throughSourceEndSu: 4
    })
    for (const change of [{ id: 'other' }, { clientGeneration: 99 }, { acceptedSourceEndSu: 0 }]) {
      expect(() => requireSshPtyLiveSourceSettlement({ ...checkpoint, ...change })).toThrow()
    }
    expect(f.order).not.toContain('exit')
    uninstall()
    expect(() => requireSshPtyLiveSourceSettlement(checkpoint)).toThrow('intake_unavailable')
  } finally {
    uninstall()
  }
})
