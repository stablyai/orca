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
  claimStatus?: string
  runtimeKind?: string
  deathEvidence?: unknown
  record?: unknown
  close?: () => Promise<void>
  setSessionTabVisibility?: () => Promise<void>
  historyThrows?: boolean
}) {
  const record =
    options.record === undefined
      ? {
          location: { executionHostId: 'local', wslDistro: null },
          lease: {
            runtimeKind: options.runtimeKind ?? 'native',
            claimStatus: options.claimStatus ?? 'live',
            deathEvidence: options.deathEvidence ?? null,
            runtimeFence: 3
          }
        }
      : options.record
  let closed = false
  hostRef.current = {
    deps: { store: { getRecord: () => record } },
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

  it('is unverifiable, never exited, when the host is not installed', () => {
    // Not being able to look is not a death certificate.
    expect(observeStructuredWorker(IDENTITY)).toEqual({
      status: 'unverifiable',
      reason: expect.stringContaining('not installed')
    })
  })

  it('is live when the host holds the session under a live native lease', () => {
    installHost({})
    expect(observeStructuredWorker(IDENTITY).status).toBe('live')
  })

  it('is exited only on a released lease with death evidence', () => {
    installHost({
      claimStatus: 'released',
      deathEvidence: { kind: 'exit-observed', detail: 'x', observedAt: 1 }
    })
    expect(observeStructuredWorker(IDENTITY).status).toBe('exited')
  })

  it('is unverifiable when the lease moved to a terminal owner', () => {
    installHost({ runtimeKind: 'tui' })
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

  it.each([
    { hasSession: false },
    { runtimeKind: 'tui' },
    { claimStatus: 'released' },
    { record: null }
  ])('retains without positive exit evidence: %j', async (options) => {
    installHost({ ...options, close: async () => {} })
    const retireStructuredAgentSessionTabFromSnapshot = vi.fn()
    const result = await stopStructuredWorker(IDENTITY, 'd1', {
      forgetStructuredSessionMail: vi.fn(),
      retireStructuredAgentSessionTabFromSnapshot
    })
    expect(result).toMatchObject({ stopped: false, closeAttempted: true })
    expect(retireStructuredAgentSessionTabFromSnapshot).not.toHaveBeenCalled()
  })

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
    // `closeAttempted` is what the receipt turns into `processAction: 'closed_agent_terminal'`.
    // Reporting it here would claim a close for a child that is still running.
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
    // `closed_agent_terminal` on a runtime that never reached a host is the receipt claiming an
    // action it did not take.
    const result = await stopStructuredWorker(IDENTITY, 'd1')
    expect(result.stopped).toBe(false)
    expect(result.closeAttempted).toBe(false)
  })
})

describe('structured worker output', () => {
  beforeEach(() => {
    hostRef.current = null
  })

  it('round-trips the journal through the archive and back out of a released read', () => {
    installHost({})
    const live = readStructuredWorkerJournal({
      identity: IDENTITY,
      dispatchId: 'd1',
      workerState: 'ready',
      liveness: 'live',
      agent: 'claude'
    })
    expect(live.source).toBe('transcript')
    const archive = captureStructuredWorkerArchive(IDENTITY, 'claude')
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

  it('redacts dispatch capabilities from the archived journal', () => {
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
    const archive = captureStructuredWorkerArchive(IDENTITY, 'claude')
    expect(JSON.stringify(archive)).not.toContain('dcap_aaa')
    expect(JSON.stringify(archive)).toContain('[dispatch capability redacted]')
  })

  it('refuses to read a session the host no longer holds', () => {
    expect(() =>
      readStructuredWorkerJournal({
        identity: IDENTITY,
        dispatchId: 'd1',
        workerState: 'ready',
        liveness: 'live',
        agent: 'claude'
      })
    ).toThrow(/not attached/)
  })

  it('reports an unverifiable worker as unknown, never as running', () => {
    // The `could not look, therefore it is alive` inversion. After a restart the runtime observes
    // `unverifiable` — no attached provider child in this generation — while the journal is still
    // readable, and a coordinator reading `running` waits on a worker that may already be gone.
    installHost({})
    const read = readStructuredWorkerJournal({
      identity: IDENTITY,
      dispatchId: 'd1',
      workerState: 'ready',
      liveness: 'unverifiable',
      agent: 'claude'
    })
    expect(read.status.terminal).toBe('unknown')
    expect(read.status.liveness).toBe('unverifiable')
  })

  it('carries each proven verdict through unchanged', () => {
    installHost({})
    const live = readStructuredWorkerJournal({
      identity: IDENTITY,
      dispatchId: 'd1',
      workerState: 'ready',
      liveness: 'live',
      agent: 'claude'
    })
    expect(live.status).toMatchObject({ terminal: 'running', liveness: 'live' })
    const exited = readStructuredWorkerJournal({
      identity: IDENTITY,
      dispatchId: 'd1',
      workerState: 'succeeded',
      liveness: 'exited',
      agent: 'claude'
    })
    expect(exited.status).toMatchObject({ terminal: 'exited', liveness: 'exited' })
  })

  it('states that a settled release is exited', () => {
    installHost({})
    const archive = captureStructuredWorkerArchive(IDENTITY, 'claude')
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

  it('never calls an unproven release exited', () => {
    // The archive is frozen BEFORE the close. `release_unknown` is the state that records a close
    // that did NOT land, and a coordinator reading `exited` there starts a replacement worker over
    // the same worktree while the original provider child may still be attached.
    installHost({})
    const archive = captureStructuredWorkerArchive(IDENTITY, 'claude')
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
    // The wiring, not just the mapping: `worker-read` reaches the archive through
    // `readArchivedWorkerOutput`, and the resource row it already holds is the only thing that
    // knows whether the close landed.
    installHost({})
    const archive = captureStructuredWorkerArchive(IDENTITY, 'claude')
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

  it('refuses a cursor once the tail window has slid past it', () => {
    // The cursor is an index into the bounded tail, and `sourceIdentity` was constant for the
    // worker's life, so a coordinator paging a growing journal resumed at the newest items and
    // skipped the middle without a word.
    installHost({ items: ITEMS })
    const first = readStructuredWorkerJournal({
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
    expect(() =>
      readStructuredWorkerJournal({
        identity: IDENTITY,
        dispatchId: 'd1',
        workerState: 'ready',
        liveness: 'live',
        agent: 'claude',
        cursor: first.cursor
      })
    ).toThrow(/source changed/i)
  })
})

describe('archiving a structured worker whose journal cannot be read', () => {
  beforeEach(() => {
    hostRef.current = null
  })

  it('settles with an empty, warned archive once the session is PROVEN gone', () => {
    // Closing the worker's chat tab is a routine user action: it evicts the child and detaches the
    // journal permanently. Throwing archive_failed there wedged release on evidence that could
    // never arrive, leaving worker-abandon as the only way out.
    installHost({
      historyThrows: true,
      claimStatus: 'released',
      deathEvidence: { kind: 'exit-observed', detail: 'surface released', observedAt: 1 }
    })
    const archive = captureStructuredWorkerArchive(IDENTITY, 'claude')
    expect(archive.messages).toEqual([])
    expect(archive.processIncarnation).toBe(IDENTITY.processIncarnation)
    expect(archive.warnings).toContain(
      'The structured session was already closed, so its journal could not be preserved.'
    )
  })

  it('still retains when the journal is unreadable but nothing proves the child is gone', () => {
    installHost({ historyThrows: true })
    expect(() => captureStructuredWorkerArchive(IDENTITY, 'claude')).toThrow(/retained/)
  })

  it('still retains when there is no host to look with', () => {
    expect(() => captureStructuredWorkerArchive(IDENTITY, 'claude')).toThrow(/retained/)
  })
})
