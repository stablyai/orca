import { afterEach, expect, it, vi } from 'vitest'
import {
  agentSessionOperationKey,
  pendingAgentSessionOperationRow,
  type AgentSessionOperationOutcome
} from '../../../shared/agent-session-operation-ledger'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'

let rig: QueuedMessageTestRig | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await rig?.dispose()
  rig = undefined
})

const outcomes: AgentSessionOperationOutcome[] = [
  { status: 'succeeded', sessionId: SESSION },
  { status: 'failed', code: 'fixture-failure' },
  { status: 'pending' },
  { status: 'unknown' }
]

it.each(['caller', 'global'] as const)(
  'Stop and send replay survive the former %s receipt quota',
  async (limit) => {
    for (const outcome of outcomes) {
      rig = await createQueuedMessageTestRig()
      const sentId = await rig.workingSend()
      const receipt = rig.store.getOperationRow(QUEUED_RIG_CALLER.callerKey, sentId)
      const count = limit === 'caller' ? 512 : 4_096
      await rig.store['transactions'].transact(({ operations: rows }) => {
        for (let index = 0; index < count; index += 1) {
          const callerKey = limit === 'caller' ? QUEUED_RIG_CALLER.callerKey : `other-${index}`
          const operationId = `${NOW}-1${index.toString(16).padStart(31, '0')}`
          const row = pendingAgentSessionOperationRow({
            callerKey,
            operationId,
            fingerprint: 'retained-fixture',
            now: NOW
          })
          rows.set(agentSessionOperationKey(callerKey, operationId), { ...row, outcome })
        }
      })
      const stopId = `${NOW}-${'f'.repeat(32)}`
      expect(await rig.stop(stopId)).toMatchObject({ ok: true, replayed: false })
      expect(rig.cancelTurn).toHaveBeenCalledOnce()
      expect(await rig.stop(stopId)).toMatchObject({ ok: true, replayed: true })
      expect(rig.cancelTurn).toHaveBeenCalledOnce()
      expect(rig.store.getOperationRow(QUEUED_RIG_CALLER.callerKey, sentId)).toEqual(receipt)
      const body = hostTestMessage('work on this')
      expect(
        await rig.host.send(QUEUED_RIG_CALLER, {
          envelope: rig.envelope({ body }, 'agentSession.send', sentId),
          body,
          userSend: true
        })
      ).toMatchObject({ ok: true, replayed: true })
      expect(rig.dispatch).toHaveBeenCalledOnce()
      await rig.dispose()
      rig = undefined
    }
  }
)

it('Stop still runs when its receipt cannot be written above the former quota', async () => {
  rig = await createQueuedMessageTestRig()
  await rig.workingSend()
  await rig.store['transactions'].transact(({ operations: rows }) => {
    for (let index = 0; index < 512; index += 1) {
      const row = pendingAgentSessionOperationRow({
        callerKey: QUEUED_RIG_CALLER.callerKey,
        operationId: `${NOW}-1${index.toString(16).padStart(31, '0')}`,
        fingerprint: 'retained-fixture',
        now: NOW
      })
      rows.set(agentSessionOperationKey(row.callerKey, row.operationId), row)
    }
  })
  vi.spyOn(rig.store, 'admitMutationOperation').mockRejectedValueOnce(new Error('write failed'))
  expect(await rig.stop()).toMatchObject({ ok: true })
  expect(rig.cancelTurn).toHaveBeenCalledOnce()
})

it.each(['caller', 'global'] as const)(
  'retains idle Stop and Send receipts above the former %s limit',
  async (limit) => {
    rig = await createQueuedMessageTestRig()
    const workCount = limit === 'caller' ? 512 : 4_096
    await rig.store['transactions'].transact(({ operations: rows }) => {
      for (let index = 0; index < workCount; index += 1) {
        const callerKey = limit === 'caller' ? QUEUED_RIG_CALLER.callerKey : `other-${index}`
        const operationId = `${NOW}-1${index.toString(16).padStart(31, '0')}`
        const row = pendingAgentSessionOperationRow({
          callerKey,
          operationId,
          fingerprint: 'retained-fixture',
          now: NOW
        })
        rows.set(agentSessionOperationKey(callerKey, operationId), {
          ...row,
          outcome: { status: 'succeeded', sessionId: SESSION }
        })
      }
    })
    const protectedRows = rig.store.listOperationRows()
    const before = rig.store.listOperationRows().length
    for (let index = 0; index < 4; index += 1) {
      expect(await rig.stop(`${NOW}-f${index.toString(16).padStart(31, '0')}`)).toMatchObject({
        ok: true
      })
    }
    expect(rig.store.listOperationRows()).toHaveLength(before + 4)
    expect(rig.store.listOperationRows()).toEqual(expect.arrayContaining(protectedRows))
    expect(rig.cancelTurn).not.toHaveBeenCalled()
    expect(await rig.send('new send above the former limit').result).toMatchObject({ ok: true })
    expect(rig.store.listOperationRows()).toHaveLength(before + 5)
  }
)

it.each(['pending', 'unknown'] as const)(
  'Stop retains its receipt when prior cleanup receipts are %s',
  async (status) => {
    rig = await createQueuedMessageTestRig()
    await rig.workingSend()
    await rig.store['transactions'].transact(({ operations: rows }) => {
      for (let index = 0; index < 64; index += 1) {
        const row = pendingAgentSessionOperationRow({
          callerKey: QUEUED_RIG_CALLER.callerKey,
          operationId: `${NOW}-1${index.toString(16).padStart(31, '0')}`,
          fingerprint: 'in-flight',
          now: NOW
        })
        rows.set(agentSessionOperationKey(row.callerKey, row.operationId), {
          ...row,
          outcome: { status }
        })
      }
    })
    const before = rig.store.listOperationRows()
    expect(await rig.stop()).toMatchObject({ ok: true })
    expect(rig.cancelTurn).toHaveBeenCalledOnce()
    expect(rig.store.listOperationRows()).toHaveLength(before.length + 1)
    expect(rig.store.listOperationRows()).toEqual(expect.arrayContaining(before))
  }
)
