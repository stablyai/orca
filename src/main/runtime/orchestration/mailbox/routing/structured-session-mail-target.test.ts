import { CrewChanges } from '../../crew/crew-changes'
import { agentSessionConversationView } from '../../../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getAppEnvironment,
  hasAppEnvironment,
  setAppEnvironment,
  type AppEnvironment
} from '../../../../../shared/app-environment'
import type {
  AgentSessionLease,
  AgentSessionRecord
} from '../../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { formatOrcaSessionAddress } from '../../../../../shared/orca-session-address'
import { testOrcaSessionId } from '../../../../../shared/orca-session-address-test-fixture'

const hostRef: { current: unknown } = { current: null }

vi.mock(
  '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry',
  () => ({
    getStructuredAgentSessionHost: () => hostRef.current
  })
)

const { OrcaRuntimeWithGetPtyRecordForPaneKey } = await import('./terminal-pane-mail-routing')
const { OrchestrationDb } = await import('../../db/orchestration-db')
const { resolveOrcaSessionParty } = await import('../../addressing/orchestration-party')
const {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} = await import('../../terminal-authority/structured-sessions/structured-worker-identity')

const CHAT = testOrcaSessionId('4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37')
const CHAT_ADDRESS = formatOrcaSessionAddress(CHAT)

/** The real methods through the real prototype chain; a re-declared copy would pin nothing. */
abstract class MailTargetProbe extends OrcaRuntimeWithGetPtyRecordForPaneKey {
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
        getConversation: (sessionId: string) => {
          const record = store.records.get(sessionId)
          return record ? agentSessionConversationView(record) : null
        },
        listConversations: () => [...store.records.values()].map(agentSessionConversationView),
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
    crewChanges: new CrewChanges(),
    ptysById: new Map(),
    orchestrationStructuredMailboxPointerDelivery: { statusChanged: () => true },
    ...extra
  })
}

function chatCoordinatedRun(): string {
  return db.createRun({
    objective: 'o',
    coordinatorHandle: null,
    coordinatorPaneKey: null,
    coordinatorOrcaSessionId: CHAT
  }).id
}

beforeEach(() => {
  db = new OrchestrationDb(':memory:')
  hostRef.current = null
})

afterEach(() => {
  db.close()
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
      continueRestoredWorkerMail: vi.fn(),
      deliverPendingMessagesForHandle: (handle: string) => delivered.push(handle),
      notifyStructuredSessionJournalActivity: vi.fn()
    })
  }

  it('opens an existing orchestration database itself, so mail stored before the restart is redriven', () => {
    // An idle edge after restart must open the orchestration DB rather than silently read its null field.
    installStore(chatRecord())
    const stored = new OrchestrationDb(join(userData, 'orchestration.db'))
    const runId = stored.createRun({
      objective: 'o',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: CHAT
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
})

describe('a coordinator chat continued by /clear', () => {
  const MIDDLE = testOrcaSessionId('clear-fedcba9876543210fedcba9876543210fedcba98')
  const SUCCESSOR = testOrcaSessionId('clear-0123456789abcdef0123456789abcdef01234567')

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

  it('keeps a Run bound, unrewritten, across a chain of clears, and delivers it to the live end', () => {
    installLineage(MIDDLE)
    const runId = chatCoordinatedRun()
    const generation = db.getRunRaw(runId)!.consumer_generation
    idleEdge(MIDDLE)
    installLineage(MIDDLE, SUCCESSOR)
    expect(idleEdge(SUCCESSOR)).toContain(`run:${runId}`)

    expect(db.getRunRaw(runId)).toMatchObject({
      coordinator_orca_session_id: CHAT,
      consumer_generation: generation
    })
    for (const member of [CHAT, MIDDLE, SUCCESSOR]) {
      expect(db.getCurrentRunForCoordinator(resolveOrcaSessionParty(member, db))?.id).toBe(runId)
    }
    expect(probe().target(`run:${runId}`)).toEqual({ sessionId: SUCCESSOR, dispatchId: null })
  })

  it('reaches the live session through any spelling of the conversation, and stores one', () => {
    installLineage(MIDDLE, SUCCESSOR)
    for (const member of [CHAT, MIDDLE, SUCCESSOR]) {
      expect(resolveOrcaSessionParty(member, db)).toMatchObject({
        orcaSessionId: CHAT,
        address: CHAT_ADDRESS
      })
      expect(probe().target(`orca_session_id:${member}`)).toEqual({
        sessionId: SUCCESSOR,
        dispatchId: null
      })
    }
    const direct = db.insertMessage({
      from: 'term_peer',
      to: CHAT_ADDRESS,
      subject: 'hi',
      type: 'status'
    })
    expect(idleEdge(SUCCESSOR)).toEqual([CHAT_ADDRESS])
    expect(db.getMessageById(direct.id)).toMatchObject({ to_handle: CHAT_ADDRESS, read: 0 })
  })
})

describe('a structured worker continued by /clear', () => {
  const WORKER = testOrcaSessionId('9c2e4a61-3f7b-4d8e-b105-6a2d8e4f1c93')
  const WORKER_SUCCESSOR = testOrcaSessionId('clear-a1b2c3d4e5f60718293a4b5c6d7e8f9012345678')

  afterEach(() => {
    structuredWorkerIdentities.clear()
  })

  /** A worker minted for WORKER, whose conversation `/clear` continued in WORKER_SUCCESSOR. */
  function clearedWorker(): { handle: string; paneKey: string } {
    const store = installStore(null)
    const minted = agentSessionRecordFixture(
      agentSessionLeaseFixture({ sessionId: WORKER, runtimeKind: 'native' })
    )
    store.records.set(WORKER, {
      ...minted,
      conversationCommand: {
        command: 'clear',
        state: 'completed',
        replacementSessionId: WORKER_SUCCESSOR,
        operationId: 'op-worker',
        callerKey: 'caller',
        phase: 'committed'
      }
    })
    store.records.set(
      WORKER_SUCCESSOR,
      agentSessionRecordFixture(
        agentSessionLeaseFixture({ sessionId: WORKER_SUCCESSOR, runtimeKind: 'native' })
      )
    )
    const identity = structuredWorkerIdentities.register({
      handle: mintStructuredWorkerHandle(),
      sessionId: WORKER,
      agent: 'codex',
      paneKey: mintStructuredWorkerPaneKey(WORKER),
      processIncarnation: structuredWorkerProcessIncarnation(WORKER),
      worktreeId: 'wt_1',
      hostScope: { kind: 'local', hostId: 'local' }
    })
    return { handle: identity.handle, paneKey: identity.paneKey }
  }

  it("delivers the worker's dispatch mailbox and a Run it coordinates to the live successor", () => {
    const { handle, paneKey } = clearedWorker()
    const dispatch = db.createDispatchContext({
      taskId: db.createTask({ runId: chatCoordinatedRun(), spec: 'work' }).id,
      assigneeHandle: handle,
      assigneePaneKey: paneKey,
      processIncarnation: structuredWorkerProcessIncarnation(WORKER),
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    expect(probe().target(`dispatch:${dispatch.id}`)).toEqual({
      sessionId: WORKER_SUCCESSOR,
      dispatchId: dispatch.id
    })
    const workerRun = db.createRun({
      objective: 'o',
      coordinatorHandle: handle,
      coordinatorPaneKey: paneKey
    }).id
    expect(probe().target(`run:${workerRun}`)).toEqual({
      sessionId: WORKER_SUCCESSOR,
      dispatchId: null
    })
  })
})
