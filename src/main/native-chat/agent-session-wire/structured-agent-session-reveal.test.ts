/**
 * Revealing a persisted chat, for both structured providers.
 *
 * The reveal path is the only way an Agent Session History row reaches a chat whose tab this
 * process never published — a chat closed cleanly, or one this process has not opened since
 * launch. It is exercised here through the readable restorer rather than the whole host, because
 * what it must get right is which records it accepts and what it does when the journal is gone.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import { StructuredAgentSessionReadableRestorer } from './structured-agent-session-readable-restorer'
import * as readRestore from './structured-agent-session-read-restore'
import * as providerSupport from './structured-agent-session-provider-support'
import { revealStructuredAgentSession } from './structured-agent-session-reveal'

function recordFor(provider: 'claude' | 'codex', sessionId: string): AgentSessionRecord {
  const record = agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId }))
  return {
    ...record,
    provider,
    providerHandleChain:
      provider === 'codex'
        ? [
            {
              ...record.providerHandleChain[0]!,
              handle: { provider: 'codex', threadId: `thread-${sessionId}` }
            }
          ]
        : record.providerHandleChain
  }
}

function harness(
  records: AgentSessionRecord[],
  options: { supports?: (record: AgentSessionRecord) => boolean } = {}
) {
  const live = new Map<string, unknown>()
  const restoreHandoff = vi.fn(async () => undefined)
  const serializedIds: string[] = []
  const serialize = <T>(sessionId: string, task: () => Promise<T>): Promise<T> => {
    serializedIds.push(sessionId)
    return task()
  }
  const restorer = new StructuredAgentSessionReadableRestorer({
    store: {
      getRecord: (sessionId: string) => records.find((r) => r.sessionId === sessionId) ?? null,
      listRecords: () => records
    } as never,
    journalRoot: '/journals',
    supportsRecord: options.supports ?? (() => true),
    reconcile: async () => null,
    resolveRecovery: async () => undefined,
    serialize,
    hasSession: (sessionId) => live.has(sessionId),
    onReadable: (sessionId, restored) => live.set(sessionId, restored),
    restoreHandoff
  })
  return { restorer, live, restoreHandoff, serializedIds }
}

const readable = { journal: {}, params: {}, fence: 1 } as never

afterEach(() => {
  vi.restoreAllMocks()
})

describe('revealing one structured session on demand', () => {
  beforeEach(() => {
    vi.spyOn(readRestore, 'restoreStructuredAgentSessionRead').mockResolvedValue(readable)
  })

  it.each(['claude', 'codex'] as const)('restores a persisted %s chat', async (provider) => {
    const sessionId = `session-${provider}`
    const { restorer, live } = harness([recordFor(provider, sessionId)])

    await expect(restorer.restoreOne(sessionId)).resolves.toBe(true)
    expect(live.has(sessionId)).toBe(true)
  })

  it('does not need the startup sweep to have run, or run it', async () => {
    // The whole point: `restore()` is latched to once per process, and a surface asking later must
    // not be answered from that latch — nor trip it, which would skip every other record.
    const records = [recordFor('codex', 'session-asked'), recordFor('claude', 'session-untouched')]
    const { restorer, live } = harness(records)

    await restorer.restoreOne('session-asked')

    expect(live.has('session-asked')).toBe(true)
    expect(live.has('session-untouched')).toBe(false)
  })

  it('serializes against the session it restores', async () => {
    const { restorer, serializedIds } = harness([recordFor('claude', 'session-serialized')])

    await restorer.restoreOne('session-serialized')

    // Ordering against close/eviction is the task queue's job, so the restore must be inside it.
    expect(serializedIds).toEqual(['session-serialized'])
  })

  it('returns the live session instead of restoring over it', async () => {
    const { restorer, live } = harness([recordFor('codex', 'session-live')])
    live.set('session-live', readable)

    await expect(restorer.restoreOne('session-live')).resolves.toBe(true)
    expect(readRestore.restoreStructuredAgentSessionRead).not.toHaveBeenCalled()
  })

  it('refuses a record no adapter supports', async () => {
    const { restorer } = harness([recordFor('codex', 'session-unsupported')], {
      supports: () => false
    })

    await expect(restorer.restoreOne('session-unsupported')).resolves.toBe(false)
    expect(readRestore.restoreStructuredAgentSessionRead).not.toHaveBeenCalled()
  })

  it('refuses a session this host holds no record for', async () => {
    const { restorer } = harness([])

    await expect(restorer.restoreOne('session-absent')).resolves.toBe(false)
  })
})

describe('a record whose journal cannot be read', () => {
  it('reports not-readable without throwing, for either provider', async () => {
    // A chat whose journal predates the SQLite store restores to nothing here. That is not a
    // refusal: attach still recovers it, so the caller publishes the tab and lets the pane's hold
    // finish the job. Throwing, or reporting success, would both be wrong.
    vi.spyOn(readRestore, 'restoreStructuredAgentSessionRead').mockResolvedValue(null)
    const { restorer, live } = harness([
      recordFor('claude', 'session-no-journal-claude'),
      recordFor('codex', 'session-no-journal-codex')
    ])

    await expect(restorer.restoreOne('session-no-journal-claude')).resolves.toBe(false)
    await expect(restorer.restoreOne('session-no-journal-codex')).resolves.toBe(false)
    expect(live.size).toBe(0)
  })
})

describe('the host answer a client acts on', () => {
  beforeEach(() => {
    // Eligibility is the router's call; these cases are about what the answer carries.
    vi.spyOn(providerSupport, 'adapterSupportsRecord').mockReturnValue(true)
  })

  function record(provider: 'claude' | 'codex', workspaceId: string) {
    const base = recordFor(provider, 'session-answered')
    return { ...base, location: { ...base.location, workspaceId } }
  }

  it("answers with the record's own workspace and provider, never a caller's", async () => {
    // The security property: a client sends only a session id, so the tab cannot be aimed at
    // another workspace by asking for one.
    const stored = record('claude', 'workspace-from-record')

    await expect(
      revealStructuredAgentSession(
        { store: { getRecord: () => stored } as never, adapter: {} as never },
        'session-answered',
        () => true,
        async () => true
      )
    ).resolves.toEqual({
      sessionId: 'session-answered',
      workspaceId: 'workspace-from-record',
      agent: 'claude',
      readable: true
    })
  })

  it('refuses a session this host holds no record for', async () => {
    await expect(
      revealStructuredAgentSession(
        { store: { getRecord: () => null } as never, adapter: {} as never },
        'session-absent',
        () => false,
        async () => false
      )
    ).rejects.toThrow('agent_session_identity_required')
  })

  it('refuses a record no adapter of this host supports', async () => {
    vi.mocked(providerSupport.adapterSupportsRecord).mockReturnValue(false)

    await expect(
      revealStructuredAgentSession(
        {
          store: { getRecord: () => record('codex', 'workspace-1') } as never,
          adapter: {} as never
        },
        'session-answered',
        () => false,
        async () => false
      )
    ).rejects.toThrow('structured_agent_session_unsupported')
  })

  it('answers not-readable without refusing when the journal could not be restored', async () => {
    // The tab is still worth publishing: attach recovers what read restore cannot.
    await expect(
      revealStructuredAgentSession(
        {
          store: { getRecord: () => record('codex', 'workspace-1') } as never,
          adapter: {} as never
        },
        'session-answered',
        () => false,
        async () => false
      )
    ).resolves.toMatchObject({ readable: false, agent: 'codex' })
  })

  it('does not restore over a session that is already live', async () => {
    const restoreReadable = vi.fn(async () => true)

    await expect(
      revealStructuredAgentSession(
        {
          store: { getRecord: () => record('codex', 'workspace-1') } as never,
          adapter: {} as never
        },
        'session-answered',
        () => true,
        restoreReadable
      )
    ).resolves.toMatchObject({ readable: true })
    expect(restoreReadable).not.toHaveBeenCalled()
  })
})
