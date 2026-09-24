import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionLease, AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'

const hostRef: { current: unknown } = { current: null }

vi.mock('../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const { OrcaRuntimeWithGetPtyRecordForPaneKey } =
  await import('../orca-runtime-get-pty-record-for-pane-key')
const { OrchestrationDb } = await import('./db')
const { agentSessionPtyWriteGate } = await import('../agent-session-pty-write-gate')

const CHAT = '4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37'
const CHAT_ACTOR = `session:${CHAT}`
const TERMINAL_VIEW_PANE = 'tab_view:77777777-7777-4777-8777-777777777777'

/** The real methods through the real prototype chain; a re-declared copy would pin nothing. */
class MailTargetProbe extends OrcaRuntimeWithGetPtyRecordForPaneKey {
  target(mailboxHandle: string): unknown {
    return this.resolveStructuredMailboxTarget(mailboxHandle)
  }
}

type Store = {
  records: Map<string, AgentSessionRecord>
  visible: { present: boolean; sessionIds: string[] }
}

function chatRecord(
  lease: Partial<AgentSessionLease> = {},
  extra: Partial<AgentSessionRecord> = {}
): AgentSessionRecord {
  return {
    ...agentSessionRecordFixture(
      agentSessionLeaseFixture({ sessionId: CHAT, runtimeKind: 'native', ...lease })
    ),
    ...extra
  }
}

function installStore(record: AgentSessionRecord | null, visible = true): Store {
  const store: Store = {
    records: new Map(record ? [[record.sessionId, record]] : []),
    visible: { present: true, sessionIds: visible && record ? [record.sessionId] : [] }
  }
  hostRef.current = {
    deps: {
      store: {
        getRecord: (sessionId: string) => store.records.get(sessionId) ?? null,
        listRecords: () => [...store.records.values()],
        getVisibleSessionTabIndex: () => store.visible
      }
    }
  }
  return store
}

let db: InstanceType<typeof OrchestrationDb>

function probe(extra: Record<string, unknown> = {}): MailTargetProbe {
  return Object.assign(Object.create(MailTargetProbe.prototype), {
    _orchestrationDb: db,
    ptysById: new Map(),
    ...extra
  }) as MailTargetProbe
}

function chatCoordinatedRun(): string {
  return db.createRun({
    objective: 'o',
    coordinatorHandle: null,
    coordinatorPaneKey: null,
    coordinatorActor: CHAT_ACTOR
  }).id
}

beforeEach(() => {
  db = new OrchestrationDb(':memory:')
  hostRef.current = null
})

afterEach(() => {
  agentSessionPtyWriteGate.detachRecordLookup()
  db.close()
})

describe('a Run whose coordinator is a chat (a session actor, no handle)', () => {
  it('delivers its mailbox to that session', () => {
    // The defect this pins: the resolver read only `coordinator_handle`, which a chat never has, so
    // neither lane claimed the Run mailbox and a worker's result never reached the chat.
    installStore(chatRecord())
    const runId = chatCoordinatedRun()
    expect(probe().target(`run:${runId}`)).toEqual({ sessionId: CHAT, dispatchId: null })
  })

  it('still delivers once the host has evicted the chat, so the delivery can wake it', () => {
    installStore(chatRecord({ claimStatus: 'released', ownerProcess: null }))
    const runId = chatCoordinatedRun()
    expect(probe().target(`run:${runId}`)).toEqual({ sessionId: CHAT, dispatchId: null })
  })

  it('leaves the mailbox to the PTY lane while the chat is in its terminal view', () => {
    installStore(chatRecord({ runtimeKind: 'tui' }))
    const runId = chatCoordinatedRun()
    expect(probe().target(`run:${runId}`)).toBeNull()
  })

  it('does not deliver to a chat that was closed, replaced by /clear, or runs on another host', () => {
    const runId = chatCoordinatedRun()
    installStore(chatRecord(), false)
    expect(probe().target(`run:${runId}`)).toBeNull()

    installStore(
      chatRecord(
        {},
        {
          conversationCommand: {
            command: 'clear',
            state: 'completed',
            replacementSessionId: '7e3b9d15-2c4a-4f86-a0b1-5c9e2d7f3b64',
            operationId: 'op',
            callerKey: 'caller',
            phase: 'committed'
          }
        }
      )
    )
    expect(probe().target(`run:${runId}`)).toBeNull()

    const remote = chatRecord()
    installStore({ ...remote, location: { ...remote.location, executionHostId: 'ssh:box' } })
    expect(probe().target(`run:${runId}`)).toBeNull()
  })

  it('ignores an actor left beside a PTY handle; the handle owns the Run', () => {
    installStore(chatRecord())
    const runId = db.createRun({
      objective: 'o',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_c:11111111-1111-4111-8111-111111111111',
      coordinatorActor: CHAT_ACTOR
    }).id
    expect(probe().target(`run:${runId}`)).toBeNull()
  })
})

describe('a session addressed directly', () => {
  it('owns its `session:<id>` mailbox', () => {
    installStore(chatRecord())
    expect(probe().target(CHAT_ACTOR)).toEqual({ sessionId: CHAT, dispatchId: null })
  })

  it('claims nothing for a malformed session address', () => {
    installStore(chatRecord())
    expect(probe().target('session:term_abc')).toBeNull()
  })
})

describe('a chat in its terminal view', () => {
  it('is reached through the PTY bound to it', () => {
    installStore(chatRecord({ runtimeKind: 'tui' }))
    agentSessionPtyWriteGate.attachRecordLookup(() => null)
    agentSessionPtyWriteGate.bindPty('pty-view', CHAT)
    const runtime = probe({
      ptysById: new Map([
        ['pty-view', { ptyId: 'pty-view', connected: true, paneKey: TERMINAL_VIEW_PANE }]
      ]),
      getTerminalHandleForPaneKey: (paneKey: string) =>
        paneKey === TERMINAL_VIEW_PANE ? 'term_view' : null
    })
    expect(runtime.getTerminalViewHandleForSession(CHAT)).toBe('term_view')
    // Its native view does not answer at the same time.
    installStore(chatRecord())
    expect(runtime.getTerminalViewHandleForSession(CHAT)).toBeNull()
  })
})

describe('the idle edge of a structured session', () => {
  it('re-derives and delivers the mailboxes the session owns, and nothing while it works', () => {
    installStore(chatRecord())
    const runId = chatCoordinatedRun()
    db.insertMessage({
      from: 'term_worker',
      to: `run:${runId}`,
      subject: 'done',
      runId,
      type: 'status'
    })
    const delivered: string[] = []
    const runtime = probe({
      deliverPendingMessagesForHandle: (handle: string) => delivered.push(handle),
      notifyStructuredSessionJournalActivity: vi.fn()
    })
    runtime.onStructuredSessionStatusForMail({ sessionId: CHAT, status: 'working' })
    expect(delivered).toEqual([])
    runtime.onStructuredSessionStatusForMail({ sessionId: CHAT, status: 'idle' })
    expect(delivered).toEqual([`run:${runId}`])
  })

  it('points direct mail at a session that coordinates nothing', () => {
    installStore(chatRecord())
    db.insertMessage({ from: 'term_peer', to: CHAT_ACTOR, subject: 'hi', type: 'status' })
    const delivered: string[] = []
    probe({
      deliverPendingMessagesForHandle: (handle: string) => delivered.push(handle),
      notifyStructuredSessionJournalActivity: vi.fn()
    }).onStructuredSessionStatusForMail({ sessionId: CHAT, status: 'idle' })
    expect(delivered).toEqual([CHAT_ACTOR])
  })
})
