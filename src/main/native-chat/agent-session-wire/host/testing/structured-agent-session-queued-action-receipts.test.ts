import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withTestAgentSessionDatabase } from '../../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { HOST_TEST_NOW as NOW } from './structured-agent-session-host-test-data.test-fixture'

const CALLER_SCOPE = { kind: 'caller', callerKey: CALLER.callerKey } as const

let rig: QueuedMessageTestRig
let serial = 0

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})

afterEach(() => rig.dispose())

function opId(at = NOW): string {
  serial += 1
  return `${at}-${serial.toString(16).padStart(32, 'e')}`
}

function receipt(id: string) {
  return rig.store.readCommandReceipt(CALLER_SCOPE, id)
}

function ledgerRow(id: string) {
  return rig.store.listOperationRows().find((row) => row.operationId === id)
}

async function failReceiptWrites(): Promise<() => Promise<void>> {
  await withTestAgentSessionDatabase(rig.root, (db) =>
    db.exec(`CREATE TRIGGER fail_queued_receipt BEFORE INSERT ON agent_session_command_receipts
    BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END`)
  )
  return () =>
    withTestAgentSessionDatabase(rig.root, (db) => db.exec('DROP TRIGGER fail_queued_receipt'))
}

const UNKNOWN = { ok: false, refusal: { code: 'agent_session_operation_unknown' } }

describe('Resume', () => {
  it('answers unknown, never success, when a no-op cannot be recorded, and records nothing', async () => {
    const id = opId()
    const restore = await failReceiptWrites()
    expect(await rig.resume(id)).toMatchObject(UNKNOWN)
    await restore()
    expect(await receipt(id)).toEqual({ verdict: 'absent' })
    expect(ledgerRow(id)).toBeUndefined()
  })
})
