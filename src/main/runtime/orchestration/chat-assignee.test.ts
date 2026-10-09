import { describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'
import { sessionRecord } from '../rpc/orchestration-session-caller-test-fixture'
import {
  chatAssigneeSessionId,
  exitedChatDispatchesForSession,
  observeChatAssignee
} from './chat-assignee'
import { OrchestrationDb } from './db'
import { formatOrcaSessionAddress } from '../../../shared/orca-session-address'
import type { AgentSessionRecordReader } from './structured-session-records'

const CHAT = testOrcaSessionId('7e3b9d15-2c4a-4f86-a0b1-5c9e2d7f3b64')

function store(record: AgentSessionRecord, visible: boolean): AgentSessionRecordReader {
  return {
    getRecord: (sessionId) => (sessionId === record.sessionId ? record : null),
    listRecords: () => [record],
    getVisibleSessionTabIndex: () => ({ present: true, sessionIds: visible ? [CHAT] : [] })
  }
}

describe('a chat assignee', () => {
  it('keeps an older clear record addressable even when its replacement is missing', () => {
    const cleared: AgentSessionRecord = {
      ...sessionRecord(CHAT),
      conversationCommand: {
        command: 'clear',
        state: 'completed',
        replacementSessionId: 'clear-missing',
        operationId: 'op',
        callerKey: 'caller',
        phase: 'committed'
      }
    }
    expect(observeChatAssignee(CHAT, null, store(cleared, true))).toMatchObject({
      status: 'live',
      session: { sessionId: CHAT }
    })
  })

  it('is named only by an Orca session ID handle', () => {
    expect(chatAssigneeSessionId(`orca_session_id:${CHAT}`)).toBe(CHAT)
    expect(chatAssigneeSessionId('term_worker')).toBeNull()
    expect(chatAssigneeSessionId(null)).toBeNull()
  })

  it('is live at rest: a released lease is not an exit', () => {
    const resting = sessionRecord(CHAT, { lease: { claimStatus: 'released' } })
    expect(observeChatAssignee(CHAT, null, store(resting, true))).toMatchObject({
      status: 'live',
      session: { sessionId: CHAT }
    })
  })

  it('has exited once its chat is closed', () => {
    expect(observeChatAssignee(CHAT, null, store(sessionRecord(CHAT), false))).toEqual({
      status: 'exited',
      reason: 'The chat was closed.'
    })
  })

  it('is unverifiable on another host, with nothing to read, never exited', () => {
    const remote = sessionRecord(CHAT, { location: { executionHostId: 'ssh:box' } })
    expect(observeChatAssignee(CHAT, null, store(remote, true))).toMatchObject({
      status: 'unverifiable'
    })
    expect(observeChatAssignee(CHAT, null, null)).toMatchObject({ status: 'unverifiable' })
    const unknown = testOrcaSessionId('3f9a1c7e-6b2d-4e85-a0c4-9d1e7b3f5a26')
    expect(observeChatAssignee(unknown, null, store(sessionRecord(CHAT), true))).toMatchObject({
      status: 'unverifiable'
    })
  })
})

describe('close settlement for an actual conversation', () => {
  it('selects only the closed conversation dispatches even beside an older replacement pointer', () => {
    const other = testOrcaSessionId('3f9a1c7e-6b2d-4e85-a0c4-9d1e7b3f5a26')
    const original: AgentSessionRecord = {
      ...sessionRecord(CHAT),
      conversationCommand: {
        command: 'clear',
        state: 'completed',
        replacementSessionId: other,
        operationId: 'older-clear',
        callerKey: 'caller',
        phase: 'committed'
      }
    }
    const records = new Map([
      [CHAT, original],
      [other, sessionRecord(other)]
    ])
    const reader: AgentSessionRecordReader = {
      getRecord: (id) => records.get(testOrcaSessionId(id)) ?? null,
      listRecords: () => {
        throw new Error('Close settlement must not enumerate records')
      },
      getVisibleSessionTabIndex: () => ({ present: true, sessionIds: [other] })
    }
    const db = new OrchestrationDb(':memory:')
    try {
      const run = db.createRun({
        objective: 'close scope',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: null
      })
      const dispatched = [CHAT, other].map((sessionId) =>
        db.createDispatchContext({
          taskId: db.createTask({ runId: run.id, spec: 'work' }).id,
          assigneeHandle: formatOrcaSessionAddress(sessionId),
          creator: { kind: 'system' },
          maxDepth: 9
        })
      )
      expect(exitedChatDispatchesForSession(CHAT, db, reader).map((row) => row.id)).toEqual([
        dispatched[0]!.id
      ])
      expect(exitedChatDispatchesForSession(other, db, reader)).toEqual([])
      records.delete(CHAT)
      expect(exitedChatDispatchesForSession(CHAT, db, reader)).toEqual([])
      const remote: AgentSessionRecord = {
        ...original,
        location: { ...original.location, executionHostId: 'ssh:box' }
      }
      records.set(CHAT, remote)
      expect(exitedChatDispatchesForSession(CHAT, db, reader)).toEqual([])
    } finally {
      db.close()
    }
  })
})
