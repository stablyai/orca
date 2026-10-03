import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  AgentSessionPromptUnavailableError,
  type StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import { performCancel, type AgentSessionTurnContext } from './structured-agent-session-turns'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { cancelStructuredAgentSessionPrompt } from './structured-agent-session-prompt-cancel'
import type { AgentSessionPromptCancelRoute } from './structured-agent-session-adapter-stop'

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

async function pendingPrompt(
  options = [{ id: 'allow', label: 'Allow' }],
  /** Raise the card in a turn that is still running, rather than on the conversation. */
  inLiveTurn = false
): Promise<{ journal: AgentSessionJournal; itemId: string }> {
  root = await mkdtemp(join(tmpdir(), 'orca-prompt-cancel-'))
  const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
  const turn = inLiveTurn
    ? await journal.appendItem(
        { ...PROMPT_IDENTITY, ordinal: 0 },
        { kind: 'turn', turnId: 'turn-1', state: 'running', startedAt: 1 },
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    : null
  const item = await journal.appendItem(
    PROMPT_IDENTITY,
    {
      kind: 'approval',
      title: 'Approve?',
      detail: null,
      options,
      resolution: {
        state: 'pending',
        selectedOptionId: null,
        resolvedBy: null,
        resolvedAt: null
      }
    },
    {
      fence: 1,
      turnScope: turn ? { kind: 'turn', turnItemId: turn.itemId } : AGENT_JOURNAL_THREAD_SCOPE
    }
  )
  return { journal, itemId: item.itemId }
}

function context(
  journal: AgentSessionJournal,
  cancelTurn: StructuredAgentSessionAdapter['cancelTurn']
): AgentSessionTurnContext {
  return {
    logger: createStructuredAgentSessionLogger(),
    sessionId: 'session-1',
    journal,
    fence: 1,
    adapter: { cancelTurn } as unknown as StructuredAgentSessionAdapter,
    persistOptions: async () => undefined,
    resolvedBy: 'client-1',
    publish: vi.fn(),
    now: () => 1
  }
}

describe('performCancel for a pending prompt', () => {
  it('refuses a stale prompt revision before reaching the provider', async () => {
    const { journal, itemId } = await pendingPrompt()
    const cancelTurn = vi.fn(async () => ({ cancelled: true }))

    const result = await performCancel(context(journal, cancelTurn), {
      clientOperationId: 'cancel-1',
      turnId: 'turn-1',
      prompt: { itemId, expectedRevision: 2 }
    })

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_item_revision_stale', currentRevision: 1 }
    })
    expect(cancelTurn).not.toHaveBeenCalled()
  })

  it("records a confirmed cancellation after the prompt's own terminal row", async () => {
    const { journal, itemId } = await pendingPrompt()
    const order: string[] = []
    const cancelTurn = vi.fn(async () => {
      order.push('interrupt')
      const current = journal.snapshot().items.find((item) => item.itemId === itemId)!
      if (current.body.kind !== 'approval') {
        throw new Error('expected approval prompt')
      }
      // The provider's frame, issued during the interrupt and not yet landed when it answers.
      void journal
        .appendItem(
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
          { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
        .then(() => order.push('lifecycle'))
      return { cancelled: true }
    })

    await expect(
      performCancel(context(journal, cancelTurn), {
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
      resolveLiveTurnId: expect.any(Function),
      prompt: { itemId }
    })
    const items = journal.snapshot().items
    expect(items.map((item) => item.body)).toEqual([
      expect.objectContaining({ resolution: expect.objectContaining({ state: 'cancelled' }) }),
      { kind: 'status', text: 'Cancellation requested.' }
    ])
    // Issued after the prompt's terminal row, so it lands after it.
    expect(items[1]!.sequence).toBeGreaterThan(items[0]!.sequence)
  })

  it('answers another Cancel of the prompt it cancelled quietly, without reaching the provider', async () => {
    const { journal, itemId } = await pendingPrompt()
    // The provider's own cancel of the card, issued while it takes the interrupt.
    const cancelTurn = vi.fn(async () => {
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
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      return { cancelled: true }
    })
    const ctx = context(journal, cancelTurn)
    const cancel = (clientOperationId: string) =>
      performCancel(ctx, {
        clientOperationId,
        turnId: 'turn-1',
        prompt: { itemId, expectedRevision: 1 }
      })

    await cancel('cancel-1')
    const rows = journal.snapshot().items.length

    // The second press names the revision it saw, which the first moved on.
    await expect(cancel('cancel-2')).resolves.toEqual({
      ok: true,
      value: { turnId: 'turn-1', cancelled: false }
    })
    expect(cancelTurn).toHaveBeenCalledOnce()
    expect(journal.snapshot().items).toHaveLength(rows)
  })

  it('still refuses a Cancel of a prompt that was answered', async () => {
    const { journal, itemId } = await pendingPrompt()
    const current = journal.snapshot().items.find((item) => item.itemId === itemId)!
    if (current.body.kind !== 'approval') {
      throw new Error('expected approval prompt')
    }
    await journal.appendItem(
      PROMPT_IDENTITY,
      {
        ...current.body,
        resolution: { state: 'resolved', selectedOptionId: 'allow', resolvedBy: 'c', resolvedAt: 1 }
      },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    const cancelTurn = vi.fn(async () => ({ cancelled: true }))

    const result = await performCancel(context(journal, cancelTurn), {
      clientOperationId: 'cancel-1',
      turnId: 'turn-1',
      prompt: { itemId, expectedRevision: 1 }
    })

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_item_revision_stale', details: { reason: 'promptMoved' } }
    })
    expect(cancelTurn).not.toHaveBeenCalled()
  })

  it('keeps the callback answerable when interruption is declined', async () => {
    const { journal, itemId } = await pendingPrompt()

    await expect(
      performCancel(
        context(journal, async () => ({ cancelled: false })),
        {
          clientOperationId: 'cancel-1',
          turnId: 'turn-1',
          prompt: { itemId, expectedRevision: 1 }
        }
      )
    ).resolves.toEqual({ ok: true, value: { turnId: 'turn-1', cancelled: false } })

    expect(journal.snapshot().items.map((item) => item.body)).toEqual([
      expect.objectContaining({ resolution: expect.objectContaining({ state: 'pending' }) })
    ])
  })

  it('propagates an unconfirmed adapter failure and leaves the prompt pending', async () => {
    const { journal, itemId } = await pendingPrompt()

    await expect(
      performCancel(
        context(journal, async () => {
          throw new Error('interrupt receipt lost')
        }),
        {
          clientOperationId: 'cancel-1',
          turnId: 'turn-1',
          prompt: { itemId, expectedRevision: 1 }
        }
      )
    ).rejects.toThrow('interrupt receipt lost')

    expect(journal.snapshot().items.map((item) => item.body)).toEqual([
      expect.objectContaining({ resolution: expect.objectContaining({ state: 'pending' }) })
    ])
  })
})

describe("a card's own Cancel, as its provider answers it", () => {
  async function cancelCard(
    answer: AgentSessionPromptCancelRoute | undefined,
    revision = 1,
    endsSession = true,
    inLiveTurn = true
  ) {
    const { journal, itemId } = await pendingPrompt(
      [
        { id: 'allow', label: 'Allow' },
        { id: 'deny', label: 'Deny' }
      ],
      inLiveTurn
    )
    const ctx = context(
      journal,
      vi.fn(async () => ({ cancelled: true }))
    )
    const answerPrompt = vi.fn<StructuredAgentSessionAdapter['answerPrompt']>(async (input) => {
      await input.commit()
    })
    const dismissPrompt = vi.fn<NonNullable<StructuredAgentSessionAdapter['dismissPrompt']>>(
      async (input) => {
        await input.commit()
      }
    )
    Object.assign(ctx.adapter, { answerPrompt, dismissPrompt, routePromptCancel: () => answer })
    const routes = {
      stop: vi.fn(async () => ({
        outcome: { ok: true as const, value: { cancelled: endsSession } },
        endsSession
      })),
      interrupt: vi.fn(async () => ({ ok: true as const, value: { cancelled: true } }))
    }
    const result = await cancelStructuredAgentSessionPrompt(
      ctx,
      { turnId: 'turn-1', prompt: { itemId, expectedRevision: revision } },
      routes
    )
    const card = journal.snapshot().items.find((item) => item.itemId === itemId)?.body
    return { result, routes, answerPrompt, dismissPrompt, card }
  }

  it('interrupts the turn holding the card for a provider that gives no answer', async () => {
    const { routes, answerPrompt } = await cancelCard(undefined)

    expect(routes.interrupt).toHaveBeenCalledOnce()
    expect(routes.stop).not.toHaveBeenCalled()
    expect(answerPrompt).not.toHaveBeenCalled()
  })

  it('records a dismissal as cancelled by the caller and has the provider decline the request', async () => {
    const { result, routes, answerPrompt, dismissPrompt, card } = await cancelCard({
      kind: 'dismiss'
    })

    expect(result).toEqual({ ok: true, value: { turnId: 'turn-1', cancelled: true } })
    expect(dismissPrompt).toHaveBeenCalledWith(expect.objectContaining({ answer: true }))
    expect(card).toMatchObject({
      resolution: { state: 'cancelled', selectedOptionId: null, resolvedBy: 'client-1' }
    })
    expect(answerPrompt).not.toHaveBeenCalled()
    expect(routes.stop).not.toHaveBeenCalled()
  })

  it("runs the chat's Stop and settles the card in its step, leaving the request to the child's end", async () => {
    const { result, routes, answerPrompt, dismissPrompt, card } = await cancelCard({
      kind: 'stop'
    })

    expect(result).toEqual({ ok: true, value: { turnId: 'turn-1', cancelled: true } })
    expect(routes.stop).toHaveBeenCalledOnce()
    expect(routes.interrupt).not.toHaveBeenCalled()
    expect(dismissPrompt).toHaveBeenCalledWith(expect.objectContaining({ answer: false }))
    expect(answerPrompt).not.toHaveBeenCalled()
    expect(card).toMatchObject({ resolution: { state: 'cancelled', resolvedBy: 'client-1' } })
  })

  it('declines the request itself when the Stop ends nothing', async () => {
    const { result, dismissPrompt, card } = await cancelCard({ kind: 'stop' }, 1, false)

    expect(result).toEqual({ ok: true, value: { turnId: 'turn-1', cancelled: true } })
    expect(dismissPrompt).toHaveBeenCalledWith(expect.objectContaining({ answer: true }))
    expect(card).toMatchObject({ resolution: { state: 'cancelled', resolvedBy: 'client-1' } })
  })

  it('still records the cancel when the provider already let the request go', async () => {
    const { journal, itemId } = await pendingPrompt()
    const ctx = context(
      journal,
      vi.fn(async () => ({ cancelled: true }))
    )
    Object.assign(ctx.adapter, {
      dismissPrompt: async () => {
        throw new AgentSessionPromptUnavailableError(itemId)
      },
      routePromptCancel: () => ({ kind: 'dismiss' })
    })

    await expect(
      cancelStructuredAgentSessionPrompt(
        ctx,
        { turnId: 'turn-1', prompt: { itemId, expectedRevision: 1 } },
        { stop: vi.fn(), interrupt: vi.fn() }
      )
    ).resolves.toMatchObject({ ok: true })
    expect(journal.snapshot().items.find((item) => item.itemId === itemId)?.body).toMatchObject({
      resolution: { state: 'cancelled', resolvedBy: 'client-1' }
    })
  })

  it('dismisses a card a turn that is no longer live raised, and stops nothing', async () => {
    const { result, routes, dismissPrompt, card } = await cancelCard(
      { kind: 'stop' },
      1,
      true,
      false
    )

    expect(result).toEqual({ ok: true, value: { turnId: 'turn-1', cancelled: true } })
    expect(routes.stop).not.toHaveBeenCalled()
    expect(dismissPrompt).toHaveBeenCalledWith(expect.objectContaining({ answer: true }))
    expect(card).toMatchObject({ resolution: { state: 'cancelled', resolvedBy: 'client-1' } })
  })

  it('refuses a card that moved on before choosing a route', async () => {
    const { result, routes } = await cancelCard({ kind: 'stop' }, 2)

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_item_revision_stale' }
    })
    expect(routes.stop).not.toHaveBeenCalled()
  })
})
