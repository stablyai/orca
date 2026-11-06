import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS } from '../../../shared/agent-session/agent-session-host-authority'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { HOST_TEST_NOW as NOW } from './structured-agent-session-host-test-data'

const CALLER_SCOPE = { kind: 'caller', callerKey: CALLER.callerKey } as const
void (NOW - AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS - 60_000)
void (NOW + 6 * 60_000)

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

function failReceiptWrites(): () => void {
  const db = openTestJournalHostDatabase(rig.root).db
  db.exec(`CREATE TRIGGER fail_queued_receipt BEFORE INSERT ON agent_session_command_receipts
    BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END`)
  return () => db.exec('DROP TRIGGER fail_queued_receipt')
}

const UNKNOWN = { ok: false, refusal: { code: 'agent_session_operation_unknown' } }

describe('Send now', () => {
  it('records nothing for a refusal before acceptance', async () => {
    const id = opId()
    expect(await rig.sendNow('no-such-card', id)).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid' }
    })
    expect(receipt(id)).toEqual({ verdict: 'absent' })
    expect(ledgerRow(id)).toBeUndefined()
  })
})

describe('Resume', () => {
  it('answers unknown, never success, when a no-op cannot be recorded, and records nothing', async () => {
    const id = opId()
    const restore = failReceiptWrites()
    expect(await rig.resume(id)).toMatchObject(UNKNOWN)
    restore()
    expect(receipt(id)).toEqual({ verdict: 'absent' })
    expect(ledgerRow(id)).toBeUndefined()
  })
})
