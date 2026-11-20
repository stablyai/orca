import { CrewChanges } from '../../crew/crew-changes'
import { agentSessionConversationView } from '../../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getAppEnvironment,
  hasAppEnvironment,
  setAppEnvironment,
  type AppEnvironment
} from '../../../../../shared/app-lifecycle/app-environment'
import type {
  AgentSessionLease,
  AgentSessionRecord
} from '../../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { formatOrcaSessionAddress } from '../../../../../shared/agent-session/identity/orca-session-address'
import { testOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address-test-fixture'

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

  it('redrives direct mail addressed to the live successor, as item mail is', () => {
    installLineage(MIDDLE, SUCCESSOR)
    const address = formatOrcaSessionAddress(SUCCESSOR)
    db.insertMessage({ from: 'orca_bot_items', to: address, subject: 'item', type: 'status' })
    expect(idleEdge(SUCCESSOR)).toEqual([address])
  })
})
