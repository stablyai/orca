// Where a message's sender opens: the host's read of a party, over the records production keeps.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'
import { OrchestrationDb } from './db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'
import { locateOrchestrationParty } from './orchestration-party-location'
import { OrchestrationError } from './orchestration-error'
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES as CODES } from '../../../shared/orchestration-session-caller-codes'
import type * as OrchestrationParty from './orchestration-party'

// The real resolver, which a test can make fail once.
const resolveParty = vi.hoisted(() => vi.fn())
vi.mock('./orchestration-party', async (importOriginal) => {
  const actual = await importOriginal<typeof OrchestrationParty>()
  resolveParty.mockImplementation(actual.resolveOrchestrationParty)
  return { ...actual, resolveOrchestrationParty: resolveParty }
})
import type { AgentSessionRecordReader } from './structured-session-records'

const ROOT = testOrcaSessionId('4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37')
const LIVE = '7e3b9d15-2c4a-4f86-a0b1-5c9e2d7f3b64'
const PANE = 'tab_worker:leaf'

let db: OrchestrationDb

beforeEach(() => {
  db = new OrchestrationDb(':memory:')
})

afterEach(() => {
  db.close()
})

function record(sessionId: string, overrides: Partial<AgentSessionRecord> = {}) {
  const base = agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId }))
  return { ...base, location: { ...base.location, workspaceId: 'wt-chat' }, ...overrides }
}

/** Two independently addressable conversations written by an older clear implementation. */
function olderClearedChat(): AgentSessionRecordReader {
  const records = new Map([
    [
      ROOT,
      record(ROOT, {
        conversationCommand: {
          command: 'clear',
          state: 'completed',
          replacementSessionId: LIVE,
          operationId: 'op',
          callerKey: 'k',
          phase: 'committed'
        }
      })
    ],
    [LIVE, record(LIVE)]
  ])
  return { getRecord: (id) => records.get(id) ?? null, listRecords: () => [...records.values()] }
}

/** This run issued `term_now` for PANE; any other handle is from an earlier run. */
function locate(
  address: string,
  deps: Partial<Parameters<typeof locateOrchestrationParty>[1]> = {},
  messageIds?: readonly string[]
) {
  return locateOrchestrationParty(
    address,
    {
      db,
      records: null,
      terminalPaneKey: (handle) => (handle === 'term_now' ? PANE : null),
      terminalHandleForPaneKey: (paneKey) => (paneKey === PANE ? 'term_now' : null),
      ...deps
    },
    messageIds
  )
}

describe('where a sender opens', () => {
  it('opens each actual conversation despite an older replacement pointer', () => {
    expect(locate(`orca_session_id:${ROOT}`, { records: olderClearedChat() })).toEqual({
      location: { kind: 'chat', sessionId: ROOT, worktreeId: 'wt-chat' }
    })
    expect(locate(`orca_session_id:${LIVE}`, { records: olderClearedChat() })).toEqual({
      location: { kind: 'chat', sessionId: LIVE, worktreeId: 'wt-chat' }
    })
    expect(locate(`orca_session_id:${ROOT}`)).toEqual({ location: null, lost: 'chat' })
  })

  it('opens a terminal this run issued at its handle', () => {
    expect(locate('term_now')).toEqual({ location: { kind: 'terminal', handle: 'term_now' } })
  })

  it('finds a terminal from an earlier run through the pane its mail was sent from', () => {
    const sent = db.insertMessage({
      from: 'term_old',
      to: 'term_chat',
      subject: 's',
      senderPaneKey: PANE
    })
    const other = db.insertMessage({
      from: 'term_other',
      to: 'term_chat',
      subject: 's',
      senderPaneKey: PANE
    })
    expect(locate('term_old', {}, [sent.id])).toEqual({
      location: { kind: 'terminal', handle: 'term_now' }
    })
    // Only mail the sender itself sent can place it, and without mail the old handle is lost.
    expect(locate('term_old', {}, [other.id])).toEqual({ location: null, lost: 'terminal' })
    expect(locate('term_old')).toEqual({ location: null, lost: 'terminal' })
  })

  it("opens a dispatch at its assignee's terminal, through the pane it was assigned", () => {
    const run = db.createRun({
      objective: 'o',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: null
    })
    const task = db.createTask({ runId: run.id, spec: 'work' })
    const dispatch = createRootDispatch(db, task.id, 'term_old', PANE)
    expect(locate(`dispatch:${dispatch.id}`)).toEqual({
      location: { kind: 'terminal', handle: 'term_now' }
    })
    expect(locate('dispatch:gone')).toEqual({ location: null })
  })

  it('never calls a dispatch this host does not run gone: a federated one has no assignee here', () => {
    const run = db.createRun({
      objective: 'o',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: null
    })
    const task = db.createTask({ runId: run.id, spec: 'remote work' })
    // At the run's home, a federated worker's dispatch is a row with no local assignee.
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    expect(locate(`dispatch:${started.dispatch.id}`)).toEqual({ location: null })
  })

  it('calls a chat gone only on proof, and leaves any other failure to the caller', () => {
    resolveParty.mockImplementationOnce(() => {
      throw new OrchestrationError(CODES.notLive, 'lost its identity')
    })
    expect(locate(`orca_session_id:${ROOT}`)).toEqual({ location: null, lost: 'chat' })
    resolveParty.mockImplementationOnce(() => {
      throw new Error('database is locked')
    })
    expect(() => locate(`orca_session_id:${ROOT}`)).toThrow('database is locked')
  })
})
