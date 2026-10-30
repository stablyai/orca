import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../shared/agent-session-record.test-fixture'
import { agentSessionConversationView } from '../../../../shared/agent-session-conversation-view'
import type { AgentSessionLease } from '../../../../shared/agent-session-record'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { StructuredWorkerIdentity } from '../../structured-worker-identity'

const hostRef: { current: unknown } = { current: null }

vi.mock('../../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))
vi.mock('./orchestration-structured-worker-session', () => ({
  releaseStructuredWorkerSession: vi.fn()
}))

const {
  captureStructuredWorkerArchive,
  observeStructuredWorker,
  readArchivedStructuredJournal,
  readStructuredWorkerJournal,
  stopStructuredWorker
} = await import('./orchestration-structured-worker-lifecycle')
const { readArchivedWorkerOutput } = await import('./orchestration/worker/worker-archive-read')

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
      store: { getConversation: () => (record ? agentSessionConversationView(record) : null) }
    },
    getPersistedVisibleSessionTabIndex: () => ({
      present: true,
      sessionIds: options.tabListed ? [IDENTITY.sessionId] : []
    }),
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

describe('structured worker observation', () => {
  beforeEach(() => {
    hostRef.current = null
  })

  it('is unverifiable, never exited, when the host is not installed', async () => {
    // Not being able to look is not a death certificate.
    expect(observeStructuredWorker(IDENTITY)).toEqual({
      status: 'unverifiable',
      reason: expect.stringContaining('not installed')
    })
  })

  it('is live when the host holds the session under a live native lease', async () => {
    installHost({})
    expect(observeStructuredWorker(IDENTITY).status).toBe('live')
  })

  it('is exited only on a released lease with death evidence', async () => {
    installHost({
      claimStatus: 'released',
      deathEvidence: { kind: 'exit-observed', detail: 'x', observedAt: 1 }
    })
    expect(observeStructuredWorker(IDENTITY).status).toBe('exited')
  })

  it('is unverifiable when a terminal an older build recorded holds the lease', async () => {
    installHost({ claimStatus: 'conflicted' })
    expect(observeStructuredWorker(IDENTITY).status).toBe('unverifiable')
  })
})

describe('structured worker stop', () => {
  beforeEach(() => {
    hostRef.current = null
  })

  it('settles only when the session is proven gone after the close', async () => {
    installHost({
      claimStatus: 'released',
      deathEvidence: { kind: 'exit-observed', detail: 'closed', observedAt: 1 }
    })
    await expect(stopStructuredWorker(IDENTITY, 'd1')).resolves.toEqual({
      stopped: true,
      closeAttempted: true
    })
  })

  it('settles a released lease whose stop was unproven: nothing is left running to close', async () => {
    // Release uncertainty sends no signal; a user-requested chat close must still be allowed.
    installHost({ claimStatus: 'released', close: async () => {} })
    await expect(stopStructuredWorker(IDENTITY, 'd1')).resolves.toEqual({
      stopped: true,
      closeAttempted: true
    })
  })

  it('retains without closing a worker whose session has no durable record', async () => {
    // Not being able to find the running session is not a reason to act on a guess.
    const close = vi.fn(async () => {})
    installHost({ record: null, close })
    const result = await stopStructuredWorker(IDENTITY, 'd1')
    expect(result).toMatchObject({ stopped: false, closeAttempted: false })
    expect(close).not.toHaveBeenCalled()
  })

  it.each([{ hasSession: false }, { claimStatus: 'conflicted' as const }])(
    'retains without positive exit evidence: %j',
    async (options) => {
      installHost({ ...options, close: async () => {} })
      const retireStructuredAgentSessionTabFromSnapshot = vi.fn()
      const result = await stopStructuredWorker(IDENTITY, 'd1', {
        forgetStructuredSessionMail: vi.fn(),
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
    const result = await stopStructuredWorker(IDENTITY, 'd1')
    expect(result.stopped).toBe(false)
    expect(result.closeAttempted).toBe(true)
    expect(result.reason).toContain('retry')
  })

  it('retains when the session is still attached after the close', async () => {
    installHost({ hasSession: true, close: async () => {} })
    const result = await stopStructuredWorker(IDENTITY, 'd1')
    expect(result.stopped).toBe(false)
  })

  it('claims no close when the tab-visibility step threw before one was issued', async () => {
    // Claiming closed_agent_terminal without an actual close would hide a still-running child.
    const close = vi.fn(async () => {})
    installHost({
      close,
      setSessionTabVisibility: async () => {
        throw new Error('the durable tab index is wedged')
      }
    })
    const result = await stopStructuredWorker(IDENTITY, 'd1')
    expect(result.stopped).toBe(false)
    expect(result.closeAttempted).toBe(false)
    expect(close).not.toHaveBeenCalled()
  })

  it('retains when the host is not installed, and claims no close', async () => {
    // Without reaching a host, no receipt may claim closed_agent_terminal.
    const result = await stopStructuredWorker(IDENTITY, 'd1')
    expect(result.stopped).toBe(false)
    expect(result.closeAttempted).toBe(false)
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

  it('refuses to read a session the host no longer holds', async () => {
    installHost({ historyThrows: true })
    await expect(
      readStructuredWorkerJournal({
        identity: IDENTITY,
        dispatchId: 'd1',
        workerState: 'ready',
        liveness: 'live',
        agent: 'claude'
      })
    ).rejects.toThrow(/not attached/)
  })

  it('refuses, typed, when there is no host to find the running session with', async () => {
    await expect(
      readStructuredWorkerJournal({
        identity: IDENTITY,
        dispatchId: 'd1',
        workerState: 'ready',
        liveness: 'live',
        agent: 'claude'
      })
    ).rejects.toMatchObject({ code: 'session_caller_not_live' })
  })

  it('reports an unverifiable worker as unknown, never as running', async () => {
    // Readable journals do not prove a current live child after restart; report unverifiable, not running.
    installHost({})
    const read = await readStructuredWorkerJournal({
      identity: IDENTITY,
      dispatchId: 'd1',
      workerState: 'ready',
      liveness: 'unverifiable',
      agent: 'claude'
    })
    expect(read.status.terminal).toBe('unknown')
    expect(read.status.liveness).toBe('unverifiable')
  })

  it('carries each proven verdict through unchanged', async () => {
    installHost({})
    const live = await readStructuredWorkerJournal({
      identity: IDENTITY,
      dispatchId: 'd1',
      workerState: 'ready',
      liveness: 'live',
      agent: 'claude'
    })
    expect(live.status).toMatchObject({ terminal: 'running', liveness: 'live' })
    const exited = await readStructuredWorkerJournal({
      identity: IDENTITY,
      dispatchId: 'd1',
      workerState: 'succeeded',
      liveness: 'exited',
      agent: 'claude'
    })
    expect(exited.status).toMatchObject({ terminal: 'exited', liveness: 'exited' })
  })

  it('states that a settled release is exited', async () => {
    installHost({})
    const archive = await captureStructuredWorkerArchive(IDENTITY, 'claude')
    const archived = readArchivedStructuredJournal({
      dispatchId: 'd1',
      workerState: 'succeeded',
      resourceId: 'res_1',
      createdAt: '2026-09-05 00:00:00',
      releaseState: 'released',
      archive
    })
    expect(archived.status).toMatchObject({ terminal: 'exited', liveness: 'exited' })
  })

  it('never calls an unproven release exited', async () => {
    // Pre-close archives do not prove exit; release_unknown may still own a live child and must not invite replacement.
    installHost({})
    const archive = await captureStructuredWorkerArchive(IDENTITY, 'claude')
    for (const releaseState of ['unknown', 'releasing'] as const) {
      const archived = readArchivedStructuredJournal({
        dispatchId: 'd1',
        workerState: 'stop_unknown',
        resourceId: 'res_1',
        createdAt: '2026-09-05 00:00:00',
        releaseState,
        archive
      })
      expect(archived.status).toMatchObject({ terminal: 'unknown', liveness: 'unverifiable' })
    }
  })

  it('carries the resource release state through the archived read', async () => {
    // Read through worker-read: only its resource row proves whether the archived child's close landed.
    installHost({})
    const archive = await captureStructuredWorkerArchive(IDENTITY, 'claude')
    const db = {
      getWorkerTerminalArchive: () => ({
        dispatch_id: 'd1',
        resource_id: 'res_1',
        kind: 'structured_journal',
        content: JSON.stringify(archive),
        created_at: '2026-09-05 00:00:00'
      })
    }
    const read = async (releaseState: string) =>
      readArchivedWorkerOutput({
        db: db as never,
        dispatchId: 'd1',
        workerState: 'stop_unknown',
        resource: {
          id: 'res_1',
          terminal_handle: IDENTITY.handle,
          release_state: releaseState
        } as never
      })
    expect((await read('unknown')).status).toMatchObject({
      terminal: 'unknown',
      liveness: 'unverifiable'
    })
    expect((await read('released')).status).toMatchObject({
      terminal: 'exited',
      liveness: 'exited'
    })
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

  it('still refuses when there is no host to look with', async () => {
    await expect(captureStructuredWorkerArchive(IDENTITY, 'claude')).rejects.toMatchObject({
      code: 'session_caller_not_live'
    })
  })
})
