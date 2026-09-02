import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { createRestartReconciler } from './structured-agent-session-restart-reconcile'

describe('createRestartReconciler', () => {
  it('reruns after an external store refresh introduces unreconciled leases', async () => {
    let record = { sessionId: 'session-1', lease: { unreconciled: true } } as AgentSessionRecord
    const reconcileOnRestart = vi.fn(async () => {
      record = { ...record, lease: { ...record.lease, unreconciled: false } }
      return new Map()
    })
    const store = {
      listRecords: () => [record],
      getRecord: () => record,
      reconcileOnRestart
    } as unknown as AgentSessionRecordStore
    const reconcile = createRestartReconciler({
      store,
      probe: async () => ({ outcome: 'pid-absent' }),
      now: () => 1
    })

    expect(await reconcile('session-1')).toBeNull()
    record = { ...record, lease: { ...record.lease, unreconciled: true } }
    expect(await reconcile('session-1')).toBeNull()
    expect(reconcileOnRestart).toHaveBeenCalledTimes(2)
  })

  it('passes every pending record through the batch owner probe', async () => {
    let records = [
      { sessionId: 'session-1', lease: { unreconciled: true } },
      { sessionId: 'session-2', lease: { unreconciled: true } }
    ] as AgentSessionRecord[]
    const probe = vi.fn(async () => ({ outcome: 'pid-absent' as const }))
    const probeMany = vi.fn(async (pending: readonly AgentSessionRecord[]) => {
      return new Map(
        pending.map((record) => [record.sessionId, { outcome: 'pid-absent' as const }])
      )
    })
    const reconcileOnRestart = vi.fn(
      async (args: {
        probeMany?: (
          pending: readonly AgentSessionRecord[]
        ) => Promise<Map<string, { outcome: 'pid-absent' }>>
      }) => {
        await args.probeMany?.(records)
        records = records.map((record) => ({
          ...record,
          lease: { ...record.lease, unreconciled: false }
        }))
        return new Map()
      }
    )
    const store = {
      listRecords: () => records,
      getRecord: (sessionId: string) =>
        records.find((record) => record.sessionId === sessionId) ?? null,
      reconcileOnRestart
    } as unknown as AgentSessionRecordStore

    await expect(
      createRestartReconciler({ store, probe, probeMany, now: () => 1 })('session-1')
    ).resolves.toBeNull()

    expect(probeMany).toHaveBeenCalledOnce()
    expect(probeMany.mock.calls[0]?.[0].map((record) => record.sessionId)).toEqual([
      'session-1',
      'session-2'
    ])
    expect(probe).not.toHaveBeenCalled()
  })
})
