import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { performCancel, type AgentSessionTurnContext } from './structured-agent-session-turns'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}
const PROMPT_IDENTITY = {
  provider: 'codex' as const,
  threadId: 'thread-1',
  turnId: 'turn-1',
  ordinal: 1
}

const journals = createTrackedJournalOpener()
let root: string | null = null

afterEach(async () => {
  await journals.closeAll()
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = null
  }
})

async function pendingPrompt(): Promise<{ journal: AgentSessionJournal; itemId: string }> {
  root = await mkdtemp(join(tmpdir(), 'orca-prompt-cancel-'))
  const journal = await journals.open({ identity: IDENTITY, journalDir: root })
  const item = await journal.appendItem(
    PROMPT_IDENTITY,
    {
      kind: 'approval',
      title: 'Approve?',
      detail: null,
      options: [{ id: 'allow', label: 'Allow' }],
      resolution: {
        state: 'pending',
        selectedOptionId: null,
        resolvedBy: null,
        resolvedAt: null
      }
    },
    { fence: 1 }
  )
  return { journal, itemId: item.itemId }
}

function context(
  journal: AgentSessionJournal,
  cancelTurn: StructuredAgentSessionAdapter['cancelTurn'],
  flushStreamedEvents: () => Promise<void>
): AgentSessionTurnContext {
  return {
    sessionId: 'session-1',
    journal,
    fence: 1,
    adapter: { cancelTurn } as unknown as StructuredAgentSessionAdapter,
    persistOptions: async () => undefined,
    resolvedBy: 'client-1',
    publish: vi.fn(),
    flushStreamedEvents,
    now: () => 1
  }
}

describe('performCancel for a pending prompt', () => {
  it('refuses a stale prompt revision before reaching the provider', async () => {
    const { journal, itemId } = await pendingPrompt()
    const cancelTurn = vi.fn(async () => ({ cancelled: true }))
    const flush = vi.fn(async () => undefined)

    const result = await performCancel(context(journal, cancelTurn, flush), {
      clientOperationId: 'cancel-1',
      turnId: 'turn-1',
      prompt: { itemId, expectedRevision: 2 }
    })

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_item_revision_stale', currentRevision: 1 }
    })
    expect(cancelTurn).not.toHaveBeenCalled()
    expect(flush).not.toHaveBeenCalled()
  })

  it('drains terminal lifecycle before recording a confirmed cancellation', async () => {
    const { journal, itemId } = await pendingPrompt()
    const order: string[] = []
    const cancelTurn = vi.fn(async () => {
      order.push('interrupt')
      return { cancelled: true }
    })
    const flush = vi.fn(async () => {
      order.push('lifecycle')
      const current = journal.snapshot().items.find((item) => item.itemId === itemId)!
      if (current.body.kind !== 'approval') {
        throw new Error('expected approval prompt')
      }
      await journal.appendItem(
        PROMPT_IDENTITY,
        {
          ...current.body,
          resolution: {
            state: 'cancelled',
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null
          }
        },
        { fence: 1 }
      )
    })

    await expect(
      performCancel(context(journal, cancelTurn, flush), {
        clientOperationId: 'cancel-1',
        turnId: 'turn-1',
        prompt: { itemId, expectedRevision: 1 }
      })
    ).resolves.toEqual({ ok: true, value: { turnId: 'turn-1', cancelled: true } })

    expect(order).toEqual(['interrupt', 'lifecycle'])
    expect(cancelTurn).toHaveBeenCalledWith({
      sessionId: 'session-1',
      turnId: 'turn-1',
      fence: 1,
      prompt: { itemId }
    })
    expect(journal.snapshot().items.map((item) => item.body)).toEqual([
      expect.objectContaining({ resolution: expect.objectContaining({ state: 'cancelled' }) }),
      { kind: 'status', text: 'Cancellation requested.' }
    ])
  })

  it('keeps the callback answerable when interruption is declined', async () => {
    const { journal, itemId } = await pendingPrompt()
    const flush = vi.fn(async () => undefined)

    await expect(
      performCancel(
        context(journal, async () => ({ cancelled: false }), flush),
        {
          clientOperationId: 'cancel-1',
          turnId: 'turn-1',
          prompt: { itemId, expectedRevision: 1 }
        }
      )
    ).resolves.toEqual({ ok: true, value: { turnId: 'turn-1', cancelled: false } })

    expect(flush).not.toHaveBeenCalled()
    expect(journal.snapshot().items.map((item) => item.body)).toEqual([
      expect.objectContaining({ resolution: expect.objectContaining({ state: 'pending' }) }),
      { kind: 'status', text: 'The provider had already finished this turn.' }
    ])
  })

  it('propagates an unconfirmed adapter failure and leaves the prompt pending', async () => {
    const { journal, itemId } = await pendingPrompt()
    const flush = vi.fn(async () => undefined)

    await expect(
      performCancel(
        context(
          journal,
          async () => {
            throw new Error('interrupt receipt lost')
          },
          flush
        ),
        {
          clientOperationId: 'cancel-1',
          turnId: 'turn-1',
          prompt: { itemId, expectedRevision: 1 }
        }
      )
    ).rejects.toThrow('interrupt receipt lost')

    expect(flush).not.toHaveBeenCalled()
    expect(journal.snapshot().items.map((item) => item.body)).toEqual([
      expect.objectContaining({ resolution: expect.objectContaining({ state: 'pending' }) })
    ])
  })

  it('surfaces a lifecycle drain failure after the provider confirms interruption', async () => {
    const { journal, itemId } = await pendingPrompt()
    const flush = vi.fn(async () => {
      throw new Error('journal drain failed')
    })

    await expect(
      performCancel(
        context(journal, async () => ({ cancelled: true }), flush),
        {
          clientOperationId: 'cancel-1',
          turnId: 'turn-1',
          prompt: { itemId, expectedRevision: 1 }
        }
      )
    ).rejects.toThrow('journal drain failed')
    expect(journal.snapshot().items).toHaveLength(1)
  })
})
