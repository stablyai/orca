import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { agentSessionFailureWords } from '../../shared/agent-session/failures/agent-session-failure-words'
import { NativeQuotaContinuationController } from './quota-fallback-native-controller'
import type { NativeQuotaFallbackConfig } from './quota-fallback-native-config'
import { confirmedQuotaCut } from './quota-fallback-journal-cut'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_NOW as NOW
} from './agent-session-wire/structured-agent-session-host-test-data'

let rig: QueuedMessageTestRig
let controller: NativeQuotaContinuationController
let now: number
let config: NativeQuotaFallbackConfig
beforeEach(async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
  now = NOW
  config = {
    enabled: true,
    verify: vi.fn<NativeQuotaFallbackConfig['verify']>(async ({ cut }) => ({
      billing: 'subscription',
      pool: 'test-pool',
      credentialRef: 'test-key-ref',
      billingProof: {
        evidenceId: 'fake-enforcement-proof',
        pool: 'test-pool',
        credentialRef: 'test-key-ref',
        sessionId: cut.sessionId,
        sourceTurnId: cut.turnItemId,
        product: 'orca-codex-native',
        funding: 'free-grant',
        productEligible: true,
        autoRecharge: false,
        paidOverflowBlocked: true,
        enforcement: 'atomic-run-cap',
        maxDebitUsd: 1,
        observedAt: NOW,
        expiresAt: NOW + 120_000
      },
      candidates: [
        {
          route: 'openai-api',
          available: true,
          modelCompatible: true,
          observedAt: NOW,
          credit: {
            remainingUsd: 10,
            maxDebitUsd: 1,
            paidOverflowBlocked: true,
            expiresAt: NOW + 120_000
          }
        }
      ]
    })),
    readApiKey: vi.fn(async () => 'fake-key'),
    report: vi.fn()
  }
  controller = makeController()
  rig.host.deps.quotaFallbackSendAllowed = controller.sendAllowed
  rig.host.deps.quotaFallbackDeliveryAllowed = controller.deliveryAllowed
})
afterEach(async () => {
  controller.dispose()
  await rig.dispose()
})
function makeController() {
  return new NativeQuotaContinuationController({
    stateDirectory: rig.root,
    hostId: 'test-host',
    host: () => rig.host,
    config,
    now: () => now
  })
}
async function quotaCut() {
  const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const identity = { provider: 'orca' as const, clientMessageId: 'limited' }
  const turnItemId = agentJournalItemKey(identity)
  await journal.appendItem(
    identity,
    {
      kind: 'turn',
      turnId: 'limited',
      state: 'completed',
      outcome: 'failure',
      startedAt: NOW,
      completedAt: NOW
    },
    { fence: 1, turnScope: { kind: 'thread' } }
  )
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'limited-failure' },
    {
      kind: 'status',
      ...agentSessionFailureWords(
        { kind: 'usageLimitReached', usageLimit: { providerCode: 'usageLimitExceeded' } },
        { surface: 'row' }
      )
    },
    { fence: 1, turnScope: { kind: 'turn', turnItemId } }
  )
  const snapshot = journal.snapshot()
  const cut = confirmedQuotaCut(SESSION, snapshot.items, snapshot.submissions)
  expect(cut).not.toBeNull()
  return cut!
}
it('reserves native ownership, submits once, binds API account, and fences restart replay', async () => {
  const cut = await quotaCut()
  await controller.onCut(cut)
  expect(config.report).toHaveBeenCalledWith(SESSION, 'submitted')
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(1))
  expect(await controller.credentials(SESSION)).toMatchObject({
    route: 'openai-api',
    apiKey: 'fake-key'
  })
  expect(config.readApiKey).toHaveBeenCalledWith('openai-api', {
    pool: 'test-pool',
    credentialRef: 'test-key-ref'
  })
  expect((await rig.send('concurrent user work').result).ok).toBe(false)
  await controller.onCut(cut)
  expect(rig.dispatch).toHaveBeenCalledTimes(1)
  controller.dispose()
  controller = makeController()
  expect(controller.sendAllowed(SESSION, 'new', 'client')).toBe(false)
  await expect(controller.credentials(SESSION)).rejects.toThrow('ownership')
  await controller.onCut(cut)
  expect(rig.dispatch).toHaveBeenCalledTimes(1)
})
it('honors personal Stop while credit verification is pending', async () => {
  const cut = await quotaCut()
  const verify = config.verify
  config.verify = async (input) => {
    await rig.stop()
    return verify(input)
  }
  await controller.onCut(cut)
  expect(config.report).toHaveBeenCalledWith(SESSION, 'sourceMovedOn')
  expect(rig.dispatch).not.toHaveBeenCalled()
})
it('rechecks expiry and personal Stop after asynchronous secret retrieval', async () => {
  await controller.onCut(await quotaCut())
  config.readApiKey = async () => {
    now += 60_001
    return 'fake-key'
  }
  await expect(controller.credentials(SESSION)).rejects.toThrow('credential')
  now = NOW
  config.readApiKey = async () => {
    await rig.stop()
    return 'fake-key'
  }
  await expect(controller.credentials(SESSION)).rejects.toThrow('ownership')
})
it('requires an enforced budget and exact account binding', async () => {
  const cut = await quotaCut()
  const verify = config.verify
  config.verify = async (input) => ({ ...(await verify(input))!, billingProof: null })
  await controller.onCut(cut)
  expect(rig.dispatch).not.toHaveBeenCalled()
  config.verify = verify
  await controller.onCut(cut)
  config.verify = async (input) => ({ ...(await verify(input))!, credentialRef: 'other-key' })
  await expect(controller.credentials(SESSION)).rejects.toThrow('cap')
  expect(config.readApiKey).not.toHaveBeenCalled()
})
it('releases the source only after the native continuation settles and its child closes', async () => {
  await controller.onCut(await quotaCut())
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(1))
  const snapshot = await rig.host.journalSnapshot(SESSION)
  const id = snapshot.submissions[0]!.clientMessageId
  await rig.settleAccepted(id, 'api-result')
  const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'api-result' },
    {
      kind: 'turn',
      turnId: 'turn-api-result',
      state: 'completed',
      outcome: 'success',
      startedAt: NOW,
      completedAt: NOW
    },
    { fence: rig.store.getRecord(SESSION)!.lease.runtimeFence, turnScope: { kind: 'thread' } }
  )
  await eventually(() => expect(config.report).toHaveBeenCalledWith(SESSION, 'settled'))
  expect(controller.sendAllowed(SESSION, 'new', 'client')).toBe(true)
  expect(controller.restoreOpenaiSubscription(SESSION)).toBe(true)
  expect(await controller.credentials(SESSION)).toBeNull()
  expect(rig.host.collaboratorsForTests().sessions.get(SESSION)?.child).toBeNull()
})

it('skips an unsupported Antigravity adapter instead of trapping the API fallback', async () => {
  const verify = config.verify
  config.verify = async (input) => {
    const proof = (await verify(input))!
    return {
      ...proof,
      candidates: [
        {
          route: 'antigravity-opus',
          observedAt: NOW,
          available: true,
          modelCompatible: true,
          fiveHourRemaining: 1,
          weeklyRemaining: 1
        },
        ...proof.candidates
      ]
    }
  }
  await controller.onCut(await quotaCut())
  expect(config.report).toHaveBeenCalledWith(SESSION, 'antigravityAdapterUnavailable')
  expect(config.report).toHaveBeenCalledWith(SESSION, 'submitted')
})
it.each(['clear', 'compact', 'rewind'] as const)(
  'rejects %s while the native fallback owns the source',
  async (command) => {
    await controller.onCut(await quotaCut())
    const operationId = `${NOW}-0123456789abcdef0123456789abcdef`
    const fields =
      command === 'rewind' ? { itemId: 'source', expectedEpoch: 'epoch-1' } : { command }
    const envelope = rig.envelope(
      fields,
      command === 'rewind' ? 'agentSession.rewind' : 'agentSession.conversationCommand',
      operationId
    )
    const reply =
      command === 'rewind'
        ? await rig.host.rewind(
            { callerKey: 'client' },
            { envelope, itemId: 'source', expectedEpoch: 'epoch-1' }
          )
        : await rig.host.conversationCommand({ callerKey: 'client' }, { envelope, command })
    expect(reply).toMatchObject({ ok: false, refusal: { details: { reason: 'handoffInFlight' } } })
  }
)

it.each([
  ['no proof', null],
  ['budget alert', { enforcement: 'spend-alert' }],
  ['delayed monthly cutoff', { enforcement: 'monthly-hard-limit-delayed' }],
  ['prepaid balance', { enforcement: 'prepaid-balance' }],
  ['other product', { product: 'orca-claude-native' }],
  ['ineligible grant', { productEligible: false }],
  ['purchased credit', { funding: 'purchased-credit' }],
  ['automatic recharge', { autoRecharge: true }],
  ['paid overflow', { paidOverflowBlocked: false }],
  ['different account', { pool: 'other-pool' }],
  ['different key', { credentialRef: 'other-ref' }],
  ['different session', { sessionId: 'other-session' }],
  ['different turn', { sourceTurnId: 'other-turn' }],
  ['stale evidence', { observedAt: NOW - 60_001 }],
  ['future evidence', { observedAt: NOW + 1 }],
  ['expired cap', { expiresAt: NOW }],
  ['larger debit than cap', { maxDebitUsd: 0.5 }]
])('holds before reading a key for %s', async (_name, changes) => {
  const verify = config.verify
  config.verify = async (input) => {
    const value = (await verify(input))!
    return {
      ...value,
      billingProof: changes === null ? null : Object.assign(value.billingProof!, changes)
    }
  }
  await controller.onCut(await quotaCut())
  expect(rig.dispatch).not.toHaveBeenCalled()
  expect(config.readApiKey).not.toHaveBeenCalled()
  expect(config.report).not.toHaveBeenCalledWith(SESSION, 'submitted')
})

it('rejects a cap that expires while fetching the secret even when the credit remains valid', async () => {
  const verify = config.verify
  config.verify = async (input) => {
    const value = (await verify(input))!
    value.billingProof!.expiresAt = NOW + 1000
    return value
  }
  await controller.onCut(await quotaCut())
  config.readApiKey = vi.fn(async () => {
    now += 1001
    return 'fake-key'
  })
  await expect(controller.credentials(SESSION)).rejects.toThrow('credential unavailable')
})
