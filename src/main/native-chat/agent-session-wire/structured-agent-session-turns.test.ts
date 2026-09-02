import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import {
  performCancel,
  performSend,
  type AgentSessionTurnContext
} from './structured-agent-session-turns'
import { DEFAULT_JOURNAL_PAYLOAD_LIMITS } from '../agent-session-journal/journal-payload-bounds'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

let root: string | null = null

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = null
  }
})

describe('performCancel', () => {
  it('acknowledges only the request and leaves the running lifecycle row intact', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-turn-cancel-'))
    const journal = await openAgentSessionJournal({ identity: IDENTITY, journalDir: root })
    const lifecycleIdentity = {
      provider: 'legacy' as const,
      agent: 'codex' as const,
      sessionId: 'session-1',
      recordId: 'turn-lifecycle:turn-1'
    }
    await journal.appendItem(
      lifecycleIdentity,
      {
        kind: 'status',
        text: 'Agent is working…',
        turnLifecycle: { turnId: 'turn-1', state: 'running' }
      },
      { fence: 1 }
    )
    const cancelTurn = vi.fn(async () => ({ cancelled: true }))
    const ctx: AgentSessionTurnContext = {
      sessionId: 'session-1',
      journal,
      fence: 1,
      adapter: { cancelTurn } as unknown as StructuredAgentSessionAdapter,
      persistOptions: async () => undefined,
      resolvedBy: 'client-1',
      publish: vi.fn(),
      now: () => 1
    }

    const result = await performCancel(ctx, {
      clientOperationId: 'cancel-1',
      turnId: 'turn-1'
    })

    expect(result).toEqual({ ok: true, value: { turnId: 'turn-1', cancelled: true } })
    expect(cancelTurn).toHaveBeenCalledOnce()
    expect(journal.snapshot().items.map((item) => item.body)).toEqual([
      {
        kind: 'status',
        text: 'Agent is working…',
        turnLifecycle: { turnId: 'turn-1', state: 'running' }
      },
      { kind: 'status', text: 'Cancellation requested.' }
    ])
  })
})

describe('performSend lifecycle capacity', () => {
  it('refuses before provider contact when dispatch plus terminal capacity cannot fit', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-turn-capacity-'))
    const journal = await openAgentSessionJournal({
      identity: IDENTITY,
      journalDir: root,
      limits: { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, maxSessionBytes: 100 * 1024 }
    })
    const dispatch = vi.fn()
    const ctx = turnContext(journal, { dispatch } as unknown as StructuredAgentSessionAdapter)

    const result = await performSend(ctx, {
      clientMessageId: 'message-1',
      payloadFingerprint: 'a'.repeat(64),
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'run' }] }
    })

    expect(result).toMatchObject({ ok: false })
    expect(dispatch).not.toHaveBeenCalled()
    expect(journal.submissions()).toEqual([])
    expect(journal.lifecycleCapacityState()).toEqual({ reservedBytes: 0, reservedAppendSlots: 0 })
  })

  it('binds a synchronous turn start to tentative capacity and releases only on terminality', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-turn-capacity-'))
    const journal = await openAgentSessionJournal({
      identity: IDENTITY,
      journalDir: root,
      limits: { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, maxSessionBytes: 400 * 1024 }
    })
    const turnIdentity = {
      provider: 'legacy' as const,
      agent: 'codex' as const,
      sessionId: 'session-1',
      recordId: 'turn-lifecycle:turn-1'
    }
    const dispatch = vi.fn(async () => {
      await journal.appendItem(
        turnIdentity,
        {
          kind: 'status',
          text: 'Agent is working…',
          turnLifecycle: { turnId: 'turn-1', state: 'running' }
        },
        { fence: 1 }
      )
      return {
        state: 'accepted' as const,
        providerIdentity: {
          provider: 'codex' as const,
          threadId: 'thread-1',
          turnId: 'turn-1',
          ordinal: 0
        }
      }
    })
    const ctx = turnContext(journal, { dispatch } as unknown as StructuredAgentSessionAdapter)

    const result = await performSend(ctx, {
      clientMessageId: 'message-1',
      payloadFingerprint: 'a'.repeat(64),
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'run' }] }
    })

    expect(result).toMatchObject({ ok: true })
    expect(journal.lifecycleCapacityState()).toEqual({
      reservedBytes: 128 * 1024,
      reservedAppendSlots: 1
    })
    await journal.appendLifecycleBatch({
      settlementId: 'turn-completed:turn-1',
      fence: 1,
      mutations: [{ kind: 'tombstone', identity: turnIdentity }]
    })
    expect(journal.lifecycleCapacityState()).toEqual({ reservedBytes: 0, reservedAppendSlots: 0 })
  })

  it('keeps response-before-start capacity on the Codex turn lifecycle identity', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-turn-capacity-'))
    const journal = await openAgentSessionJournal({
      identity: IDENTITY,
      journalDir: root,
      limits: { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, maxSessionBytes: 220 * 1024 }
    })
    const turnIdentity = {
      provider: 'legacy' as const,
      agent: 'codex' as const,
      sessionId: 'session-1',
      recordId: 'turn-lifecycle:turn-1'
    }
    const ctx = turnContext(journal, {
      dispatch: vi.fn(async () => ({
        state: 'accepted' as const,
        providerIdentity: {
          provider: 'codex' as const,
          threadId: 'thread-1',
          turnId: 'turn-1',
          ordinal: 0
        }
      }))
    } as unknown as StructuredAgentSessionAdapter)

    await expect(
      performSend(ctx, {
        clientMessageId: 'message-1',
        payloadFingerprint: 'a'.repeat(64),
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'run' }] }
      })
    ).resolves.toMatchObject({ ok: true })
    await expect(
      journal.appendItem(
        turnIdentity,
        {
          kind: 'status',
          text: 'Agent is working…',
          turnLifecycle: { turnId: 'turn-1', state: 'running' }
        },
        { fence: 1 }
      )
    ).resolves.toBeDefined()
    expect(
      journal
        .snapshot()
        .items.some(
          (item) =>
            item.body.kind === 'status' &&
            item.body.turnLifecycle?.turnId === 'turn-1' &&
            item.body.turnLifecycle.state === 'running'
        )
    ).toBe(true)
  })

  it('transfers non-Codex reservations so repeated sends can settle without leaking capacity', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-turn-capacity-'))
    const journal = await openAgentSessionJournal({
      identity: IDENTITY,
      journalDir: root,
      limits: { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, maxSessionBytes: 220 * 1024 }
    })
    const dispatch = vi.fn(async ({ clientMessageId }: { clientMessageId: string }) => ({
      state: 'accepted' as const,
      providerIdentity: {
        provider: 'claude' as const,
        sessionId: 'claude-session',
        uuid: `turn-${clientMessageId}`
      }
    }))
    const ctx = turnContext(journal, { dispatch } as unknown as StructuredAgentSessionAdapter)

    for (let index = 0; index < 6; index += 1) {
      const clientMessageId = `message-${index}`
      const result = await performSend(ctx, {
        clientMessageId,
        payloadFingerprint: 'a'.repeat(64),
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'run' }] }
      })
      expect(result).toMatchObject({ ok: true })
      await journal.appendItem(
        {
          provider: 'claude',
          sessionId: 'claude-session',
          uuid: `turn-${clientMessageId}`
        },
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'done' }] },
        { fence: 1 }
      )
      expect(journal.lifecycleCapacityState()).toEqual({ reservedBytes: 0, reservedAppendSlots: 0 })
    }
  })
})

function turnContext(
  journal: Awaited<ReturnType<typeof openAgentSessionJournal>>,
  adapter: StructuredAgentSessionAdapter
): AgentSessionTurnContext {
  return {
    sessionId: 'session-1',
    journal,
    fence: 1,
    adapter,
    persistOptions: async () => undefined,
    resolvedBy: 'client-1',
    publish: vi.fn(),
    now: () => 1
  }
}
