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

const { readStructuredWorkerJournal, stopStructuredWorker } =
  await import('./orchestration-structured-worker-lifecycle')
await import('../../../../orchestration/terminal-authority/structured-sessions/structured-worker-authority')
await import('../worker/output/worker-archive-read')

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
