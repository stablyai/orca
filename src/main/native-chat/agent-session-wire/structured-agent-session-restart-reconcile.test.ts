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
})
