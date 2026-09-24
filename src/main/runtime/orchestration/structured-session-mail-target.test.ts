import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getAppEnvironment,
  hasAppEnvironment,
  setAppEnvironment,
  type AppEnvironment
} from '../../../shared/app-environment'
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
const { sessionOrchestrationIdentity } = await import('./structured-session-mail-address')

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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a prototype-only probe; every field the methods read is assigned below.
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

  it('does not deliver to a chat that was closed, cleared into no known session, or runs on another host', () => {
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

  it('does not deliver to an actor written at an earlier generation of the Run', () => {
    // An older binary's rebind or unbind bumps the generation and leaves the actor behind.
    installStore(chatRecord())
    const runId = chatCoordinatedRun()
    db.db
      .prepare('UPDATE runs SET consumer_generation = consumer_generation + 1 WHERE id = ?')
      .run(runId)
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
      notifyStructuredSessionJournalActivity: vi.fn(),
      cancelMessageWaiters: vi.fn()
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
      notifyStructuredSessionJournalActivity: vi.fn(),
      cancelMessageWaiters: vi.fn()
    }).onStructuredSessionStatusForMail({ sessionId: CHAT, status: 'idle' })
    expect(delivered).toEqual([CHAT_ACTOR])
  })
})

describe('the idle edge after a restart, before any orchestration call', () => {
  let userData: string
  let previousEnvironment: AppEnvironment | null

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'orca-idle-edge-db-'))
    previousEnvironment = hasAppEnvironment() ? getAppEnvironment() : null
    setAppEnvironment({
      getPath: () => userData,
      getAppPath: () => userData,
      getVersion: () => '0.0.0-test',
      isPackaged: () => false,
      onWillQuit: () => {},
      exit: () => {},
      getAppMetrics: () => []
    })
  })

  afterEach(() => {
    if (previousEnvironment) {
      setAppEnvironment(previousEnvironment)
    }
    rmSync(userData, { recursive: true, force: true })
  })

  /** A runtime whose database has not been opened in this process yet. */
  function restarted(delivered: string[]): MailTargetProbe {
    return probe({
      _orchestrationDb: null,
      ensureOrchestrationFederationRelay: vi.fn(),
      scheduleRestoredMessageRepoints: vi.fn(),
      deliverPendingMessagesForHandle: (handle: string) => delivered.push(handle),
      notifyStructuredSessionJournalActivity: vi.fn()
    })
  }

  it('opens an existing orchestration database itself, so mail stored before the restart is redriven', () => {
    // The strand this pins: the edge read the raw database field, null until the first
    // orchestration RPC opened it, so a restarted chat's idle edges silently redrove nothing.
    installStore(chatRecord())
    const stored = new OrchestrationDb(join(userData, 'orchestration.db'))
    const runId = stored.createRun({
      objective: 'o',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorActor: CHAT_ACTOR
    }).id
    stored.close()
    const delivered: string[] = []
    const runtime = restarted(delivered)

    runtime.onStructuredSessionStatusForMail({ sessionId: CHAT, status: 'idle' })

    expect(delivered).toEqual([`run:${runId}`])
    runtime.getOrchestrationDb().close()
  })

  it('creates no database for a profile that never orchestrated, and says nothing', () => {
    installStore(chatRecord())
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const delivered: string[] = []

    restarted(delivered).onStructuredSessionStatusForMail({ sessionId: CHAT, status: 'idle' })

    expect(delivered).toEqual([])
    expect(existsSync(join(userData, 'orchestration.db'))).toBe(false)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('says so when the database cannot be opened, instead of skipping silently', () => {
    installStore(chatRecord())
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const deliver = vi.fn()
    probe({
      _orchestrationDb: null,
      getExistingOrchestrationDb: () => {
        throw new Error('userData unavailable')
      },
      deliverPendingMessagesForHandle: deliver,
      notifyStructuredSessionJournalActivity: vi.fn()
    }).onStructuredSessionStatusForMail({ sessionId: CHAT, status: 'idle' })
    expect(deliver).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      '[orchestration] skipped a structured session mail edge: no database',
      { sessionId: CHAT, error: 'userData unavailable' }
    )
    warn.mockRestore()
  })
})

describe('a coordinator chat continued by /clear', () => {
  const MIDDLE = 'clear-fedcba9876543210fedcba9876543210fedcba98'
  const SUCCESSOR = 'clear-0123456789abcdef0123456789abcdef01234567'

  function sessionRecord(sessionId: string, clearedInto?: string): AgentSessionRecord {
    const record = agentSessionRecordFixture(
      agentSessionLeaseFixture({
        sessionId,
        runtimeKind: 'native',
        ...(clearedInto ? { claimStatus: 'released' as const, ownerProcess: null } : {})
      })
    )
    return clearedInto
      ? {
          ...record,
          conversationCommand: {
            command: 'clear',
            state: 'completed',
            replacementSessionId: clearedInto,
            operationId: `op-${sessionId}`,
            callerKey: 'caller',
            phase: 'committed'
          }
        }
      : record
  }

  /** CHAT cleared into each of `chain` in turn; the last one is live and its tab is open. */
  function installLineage(...chain: string[]): void {
    const lineage = [CHAT, ...chain]
    const store = installStore(null)
    lineage.forEach((sessionId, index) =>
      store.records.set(sessionId, sessionRecord(sessionId, lineage[index + 1]))
    )
    store.visible.sessionIds.push(lineage.at(-1)!)
  }

  function idleEdge(sessionId: string): string[] {
    const delivered: string[] = []
    probe({
      deliverPendingMessagesForHandle: (handle: string) => delivered.push(handle),
      notifyStructuredSessionJournalActivity: vi.fn()
    }).onStructuredSessionStatusForMail({ sessionId, status: 'idle' })
    return delivered
  }

  function runCreatedBy(sessionId: string): string {
    return db.createRun({
      objective: 'o',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorActor: sessionOrchestrationIdentity(sessionId, db).actor
    }).id
  }

  it("never unbinds the successor's own Run", () => {
    // The strand this pins: the successor's own run-create, then its idle edge rebinding the
    // predecessor's Run through an exclusive bind, which unbound the Run the successor created.
    installLineage(SUCCESSOR)
    chatCoordinatedRun()
    const ownRun = runCreatedBy(SUCCESSOR)
    const generation = db.getRunRaw(ownRun)!.consumer_generation

    expect(idleEdge(SUCCESSOR)).toContain(`run:${ownRun}`)
    idleEdge(SUCCESSOR)

    const successor = sessionOrchestrationIdentity(SUCCESSOR, db)
    expect(db.getRunRaw(ownRun)).toMatchObject({
      coordinator_actor: successor.actor,
      consumer_generation: generation
    })
    expect(db.getCurrentRunForCoordinator(successor)?.id).toBe(ownRun)
  })

  it('keeps a Run bound, unrewritten, across a chain of clears, and delivers it to the live end', () => {
    installLineage(MIDDLE)
    const runId = chatCoordinatedRun()
    const generation = db.getRunRaw(runId)!.consumer_generation
    idleEdge(MIDDLE)
    installLineage(MIDDLE, SUCCESSOR)
    expect(idleEdge(SUCCESSOR)).toContain(`run:${runId}`)

    expect(db.getRunRaw(runId)).toMatchObject({
      coordinator_actor: CHAT_ACTOR,
      consumer_generation: generation
    })
    for (const member of [CHAT, MIDDLE, SUCCESSOR]) {
      expect(db.getCurrentRunForCoordinator(sessionOrchestrationIdentity(member, db))?.id).toBe(
        runId
      )
    }
    expect(probe().target(`run:${runId}`)).toEqual({ sessionId: SUCCESSOR, dispatchId: null })
  })

  it('keeps the Run a middle session created bound after the next clear', () => {
    // The chain strand: adopting each predecessor's Run in turn unbound all but the last adopted.
    installLineage(MIDDLE)
    runCreatedBy(CHAT)
    const middleRun = runCreatedBy(MIDDLE)
    const generation = db.getRunRaw(middleRun)!.consumer_generation
    installLineage(MIDDLE, SUCCESSOR)
    idleEdge(SUCCESSOR)

    const successor = sessionOrchestrationIdentity(SUCCESSOR, db)
    expect(db.getRunRaw(middleRun)).toMatchObject({
      coordinator_actor: successor.actor,
      consumer_generation: generation
    })
    expect(db.getCurrentRunForCoordinator(successor)?.id).toBe(middleRun)
  })

  it('reaches the live session through any spelling of the conversation, and stores one', () => {
    installLineage(MIDDLE, SUCCESSOR)
    for (const member of [CHAT, MIDDLE, SUCCESSOR]) {
      expect(sessionOrchestrationIdentity(member, db)).toMatchObject({
        actor: CHAT_ACTOR,
        address: CHAT_ACTOR
      })
      expect(probe().target(`session:${member}`)).toEqual({
        sessionId: SUCCESSOR,
        dispatchId: null
      })
    }
    const direct = db.insertMessage({
      from: 'term_peer',
      to: CHAT_ACTOR,
      subject: 'hi',
      type: 'status'
    })
    expect(idleEdge(SUCCESSOR)).toEqual([CHAT_ACTOR])
    expect(db.getMessageById(direct.id)).toMatchObject({ to_handle: CHAT_ACTOR, read: 0 })
  })
})
