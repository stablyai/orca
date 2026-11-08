import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { agentSessionConversationView } from '../../../../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import type { AgentSessionLease } from '../../../../../../shared/agent-session/lifecycle/agent-session-record'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredWorkerIdentity } from '../../../../orchestration/terminal-authority/structured-sessions/structured-worker-identity'

const hostRef: { current: unknown } = { current: null }

vi.mock(
  '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry',
  () => ({
    getStructuredAgentSessionHost: () => hostRef.current
  })
)
vi.mock('./orchestration-structured-worker-session', () => ({
  releaseStructuredWorkerSession: vi.fn()
}))

const {
  captureStructuredWorkerArchive,
  readArchivedStructuredJournal,
  readStructuredWorkerJournal,
  stopStructuredWorker
} = await import('./orchestration-structured-worker-lifecycle')
await import('../../../../orchestration/terminal-authority/structured-sessions/structured-worker-authority')
await import('../worker/worker-archive-read')

const IDENTITY: StructuredWorkerIdentity = {
  handle: 'structworker_1',
  sessionId: 'session-1',
  agent: 'claude',
  paneKey: 'structured-agent-session-session-1:11111111-1111-4111-a111-111111111111',
  processIncarnation: 'structured:session-1',
  worktreeId: 'wt_1',
  hostScope: { kind: 'local', hostId: 'local' }
}

const ITEMS: AgentJournalRenderItem[] = [
  {
    itemId: 'i1',
    observedAt: 1,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'hello' }] }
  } as unknown as AgentJournalRenderItem
]

function installHost(options: {
  items?: AgentJournalRenderItem[]
  hasSession?: boolean
  claimStatus?: AgentSessionLease['claimStatus']
  deathEvidence?: AgentSessionLease['deathEvidence']
  record?: null
  close?: () => Promise<void>
  setSessionTabVisibility?: () => Promise<void>
  historyThrows?: boolean
  tabListed?: boolean
}) {
  const record =
    options.record === null
      ? null
      : agentSessionRecordFixture(
          agentSessionLeaseFixture({
            sessionId: IDENTITY.sessionId,
            claimStatus: options.claimStatus ?? 'live',
            deathEvidence: options.deathEvidence ?? null,
            runtimeFence: 3
          })
        )
  let closed = false
  hostRef.current = {
    deps: {
      logger: { warn: vi.fn() },
      store: { getConversation: () => (record ? agentSessionConversationView(record) : null) }
    },
    getPersistedVisibleSessionTabIndex: () => ({
      present: true,
      sessionIds: options.tabListed ? [IDENTITY.sessionId] : []
    }),
    getSessionTabId: () => (options.tabListed ? 'tab-1' : null),
    hasSession: () => (closed ? false : (options.hasSession ?? true)),
    setSessionTabVisibility: options.setSessionTabVisibility ?? (async () => {}),
    close:
      options.close ??
      (async () => {
        closed = true
      }),
    history: () => {
      if (options.historyThrows) {
        throw new Error('agent_session_not_attached')
      }
      return { ok: true, page: { items: options.items ?? ITEMS, hasOlder: false } }
    }
  }
}

describe('structured worker stop', () => {
  beforeEach(() => {
    hostRef.current = null
  })

  it('retains without closing a worker whose session has no durable record', async () => {
    // Not being able to find the running session is not a reason to act on a guess.
    const close = vi.fn(async () => {})
    installHost({ record: null, close })
    const result = await stopStructuredWorker(IDENTITY)
    expect(result).toMatchObject({ stopped: false, closeAttempted: false })
    expect(close).not.toHaveBeenCalled()
  })

  it.each([{ hasSession: false }, { claimStatus: 'conflicted' as const }])(
    'retains without positive exit evidence: %j',
    async (options) => {
      installHost({ ...options, close: async () => {} })
      const retireStructuredAgentSessionTabFromSnapshot = vi.fn()
      const result = await stopStructuredWorker(IDENTITY, {
        forgetStructuredSessionMail: vi.fn(),
        captureStructuredAgentSessionPresentation: () => ({ raw: null, saved: [] }),
        currentLocalStructuredSessionPresentation: () => null,
        removeCapturedStructuredSessionSavedTabs: vi.fn(),
        retireStructuredAgentSessionTabFromSnapshot
      })
      expect(result).toMatchObject({ stopped: false, closeAttempted: true })
      expect(retireStructuredAgentSessionTabFromSnapshot).not.toHaveBeenCalled()
    }
  )

  it('retains when the close throws, and admits the close was issued', async () => {
    installHost({
      close: async () => {
        throw new Error('close is queued for retry')
      }
    })
    const result = await stopStructuredWorker(IDENTITY)
    expect(result.stopped).toBe(false)
    expect(result.closeAttempted).toBe(true)
    expect(result.reason).toContain('retry')
  })

  it('retains when the session is still attached after the close', async () => {
    installHost({ hasSession: true, close: async () => {} })
    const result = await stopStructuredWorker(IDENTITY)
    expect(result.stopped).toBe(false)
  })

  it('attempts provider close despite a failed tab visibility write', async () => {
    // Claiming closed_agent_terminal without an actual close would hide a still-running child.
    const close = vi.fn(async () => {})
    installHost({
      close,
      setSessionTabVisibility: async () => {
        throw new Error('the durable tab index is wedged')
      }
    })
    const result = await stopStructuredWorker(IDENTITY)
    expect(result.stopped).toBe(false)
    expect(result.closeAttempted).toBe(true)
    expect(close).toHaveBeenCalledOnce()
  })
})

describe('structured worker output', () => {
  beforeEach(() => {
    hostRef.current = null
  })

  it('round-trips the journal through the archive and back out of a released read', async () => {
    installHost({})
    const live = await readStructuredWorkerJournal({
      identity: IDENTITY,
      dispatchId: 'd1',
      workerState: 'ready',
      liveness: 'live',
      agent: 'claude'
    })
    expect(live.source).toBe('transcript')
    const archive = await captureStructuredWorkerArchive(IDENTITY, 'claude')
    hostRef.current = null
    const archived = readArchivedStructuredJournal({
      dispatchId: 'd1',
      workerState: 'succeeded',
      resourceId: 'res_1',
      createdAt: '2026-09-05 00:00:00',
      releaseState: 'released',
      archive
    })
    expect(archived.source).toBe('transcript')
    expect(archived.archived).toBe(true)
    expect(archived.transcript?.messages).toHaveLength(1)
    expect(archived.transcript?.messages[0]?.blocks[0]).toMatchObject({ text: 'hello' })
    // The frozen source has its own identity, so a live cursor cannot be replayed against it.
    expect(archived.sourceIdentity).not.toBe(live.sourceIdentity)
  })

  it('redacts dispatch capabilities from the archived journal', async () => {
    installHost({
      items: [
        {
          itemId: 'i1',
          observedAt: 1,
          body: {
            kind: 'message',
            role: 'assistant',
            blocks: [{ type: 'text', text: `token dcap_${'a'.repeat(30)} here` }]
          }
        } as unknown as AgentJournalRenderItem
      ]
    })
    const archive = await captureStructuredWorkerArchive(IDENTITY, 'claude')
    expect(JSON.stringify(archive)).not.toContain('dcap_aaa')
    expect(JSON.stringify(archive)).toContain('[dispatch capability redacted]')
  })

  it('refuses a cursor once the tail window has slid past it', async () => {
    // A stable identity over a sliding bounded tail skipped middle pages; cursor identity must cover index shifts.
    installHost({ items: ITEMS })
    const first = await readStructuredWorkerJournal({
      identity: IDENTITY,
      dispatchId: 'd1',
      workerState: 'ready',
      liveness: 'live',
      agent: 'claude'
    })
    installHost({
      items: [
        {
          itemId: 'i2',
          observedAt: 2,
          body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'later' }] }
        } as unknown as AgentJournalRenderItem
      ]
    })
    await expect(
      readStructuredWorkerJournal({
        identity: IDENTITY,
        dispatchId: 'd1',
        workerState: 'ready',
        liveness: 'live',
        agent: 'claude',
        cursor: first.cursor
      })
    ).rejects.toThrow(/source changed/i)
  })
})

describe('archiving a structured worker whose journal cannot be read', () => {
  beforeEach(() => {
    hostRef.current = null
  })

  it('settles with an empty, warned archive once the session is PROVEN gone', async () => {
    // A user-closed chat cannot produce future journal evidence; archive_failed must not wedge release forever.
    installHost({
      historyThrows: true,
      claimStatus: 'released',
      deathEvidence: { kind: 'exit-observed', detail: 'surface released', observedAt: 1 }
    })
    const archive = await captureStructuredWorkerArchive(IDENTITY, 'claude')
    expect(archive.messages).toEqual([])
    expect(archive.processIncarnation).toBe(IDENTITY.processIncarnation)
    expect(archive.warnings).toContain(
      'The structured session was already closed, so its journal could not be preserved.'
    )
  })

  it('retains a worker at rest: released, but its chat tab still lists it', async () => {
    // Idle-sweep release is not retirement; owned unreadable journals retain evidence for later archive.
    installHost({
      historyThrows: true,
      claimStatus: 'released',
      deathEvidence: { kind: 'exit-observed', detail: 'idle stop', observedAt: 1 },
      tabListed: true
    })
    await expect(captureStructuredWorkerArchive(IDENTITY, 'claude')).rejects.toThrow(/retained/)
  })

  it('still retains when the journal is unreadable but nothing proves the child is gone', async () => {
    installHost({ historyThrows: true })
    await expect(captureStructuredWorkerArchive(IDENTITY, 'claude')).rejects.toThrow(/retained/)
  })
})
