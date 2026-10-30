import { expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { mintAgentSessionOperationId } from './structured-pointer-operation-id'
import { ordinaryMailCreationId } from './structured-mailbox-pointer-delivery'

it('uses legal ordinary IDs stable for the canonical run/message, independent of source reset and same-size batches', () => {
  const db = new OrchestrationDb(':memory:')
  try {
    const first = db.insertMessage({ from: 'worker', to: 'consumer', subject: 'first' })
    const second = db.insertMessage({ from: 'worker', to: 'consumer', subject: 'second' })
    const id = ordinaryMailCreationId(first)
    expect(id).toMatch(/^\d{13}-[0-9a-f]{32}$/)
    expect(mintAgentSessionOperationId(Date.now())).toMatch(/^\d{13}-[0-9a-f]{32}$/)
    expect(ordinaryMailCreationId(second)).not.toBe(id)
    expect(ordinaryMailCreationId({ ...first, run_id: 'other-run' })).not.toBe(id)
  } finally {
    db.close()
  }
})
