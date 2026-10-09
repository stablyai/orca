import { describe, expect, it, vi } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import { locateStructuredSessionRecord } from './structured-session-records'

const SESSION = 'conversation-1'

function olderClearRecord() {
  return {
    ...agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: SESSION })),
    conversationCommand: {
      command: 'clear',
      state: 'completed',
      replacementSessionId: 'missing-replacement',
      operationId: 'old-clear',
      callerKey: 'caller',
      phase: 'committed'
    } as const
  }
}

describe('a structured conversation record', () => {
  it('reads its own record without following an older pointer or enumerating other records', () => {
    const record = olderClearRecord()
    const getRecord = vi.fn((id: string) => (id === SESSION ? record : null))
    const listRecords = vi.fn(() => {
      throw new Error('Record enumeration must not be needed to locate a conversation')
    })
    expect(locateStructuredSessionRecord({ getRecord, listRecords }, SESSION)).toEqual({
      kind: 'here',
      sessionId: SESSION,
      record
    })
    expect(getRecord.mock.calls).toEqual([[SESSION]])
    expect(listRecords).not.toHaveBeenCalled()
  })

  it.each([
    { executionHostId: 'ssh:box', wslDistro: null },
    { executionHostId: 'local', wslDistro: 'Ubuntu' }
  ] as const)('keeps execution authority on its actual host: %j', (location) => {
    const original = olderClearRecord()
    const record = { ...original, location: { ...original.location, ...location } }
    const store = { getRecord: () => record, listRecords: () => [record] }
    expect(locateStructuredSessionRecord(store, SESSION)).toMatchObject({
      kind: 'other-host',
      sessionId: SESSION,
      record
    })
  })

  it('keeps missing, unreadable and unavailable actual records unverifiable', () => {
    const absent = { getRecord: () => null, listRecords: () => [] }
    const unreadable = {
      ...absent,
      getRecord: () => {
        throw new Error('The execution host cannot be reached')
      }
    }
    for (const store of [absent, unreadable, null]) {
      expect(locateStructuredSessionRecord(store, SESSION)).toMatchObject({
        kind: 'unverifiable'
      })
    }
  })
})
