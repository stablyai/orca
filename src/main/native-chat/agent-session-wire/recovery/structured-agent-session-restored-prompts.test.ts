import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalApprovalItem,
  AgentJournalRenderItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionTurnCompletionEvent } from '../../../../shared/agent-session/view/agent-session-turn-completion-wire'
import {
  StructuredAgentSessionRestoredPrompts,
  type StructuredAgentSessionRestoredPromptsDeps
} from './structured-agent-session-restored-prompts'

const SESSION = 'session-1'
const OPTIONS: AgentJournalApprovalItem['options'] = [
  { id: 'allow', label: 'Allow', intent: 'allow_once' },
  { id: 'deny', label: 'Deny', intent: 'reject_once' }
]

function approval(
  itemId: string,
  digest: string,
  state: 'pending' | 'cancelled'
): AgentJournalRenderItem {
  return {
    itemId,
    revision: 1,
    sequence: itemId === 'old' ? 2 : 5,
    observedAt: 1,
    turnScope: { kind: 'turn', turnItemId: 'turn-1' },
    body: {
      kind: 'approval',
      title: 'Run a command?',
      detail: 'pnpm test --filter api',
      options: OPTIONS,
      requestDigest: digest,
      resolution: {
        state,
        selectedOptionId: null,
        resolvedBy: null,
        resolvedAt: null,
        ...(state === 'cancelled' ? { endedBy: 'agent_exit' } : {})
      }
    }
  }
}

function rig() {
  const items = new Map<string, AgentJournalRenderItem>([
    ['old', approval('old', 'digest-a', 'cancelled')]
  ])
  let emit: ((event: AgentSessionTurnCompletionEvent) => void) | null = null
  let running = false
  const sent: string[] = []
  const respond = vi.fn(async () => ({ ok: false as const, refusal: {} as never }))
  const journal = {
    reads: {
      item: async (id: string) => items.get(id) ?? null,
      generation: async () => ({ items: [...items.values()] }),
      cursor: async () => ({ epoch: 'e', sequence: 9 })
    },
    mutatePrompt: async (input: { itemId: string; resolution: never }) => {
      const current = items.get(input.itemId)!
      items.set(input.itemId, {
        ...current,
        revision: current.revision + 1,
        body: { ...(current.body as AgentJournalApprovalItem), resolution: input.resolution }
      })
      return { itemId: input.itemId, revision: current.revision + 1 }
    }
  }
  const deps = {
    conversation: async () => ({ journal }),
    agentRunning: () => running,
    continuationHost: () => ({
      conversationFence: () => 3,
      now: () => 1_000,
      send: async (input: {
        body: { blocks: { text: string }[] }
        beforeRun?: () => Promise<void>
      }) => {
        await input.beforeRun?.()
        running = true
        sent.push(input.body.blocks[0]!.text)
        return { ok: true, value: { submission: { dispatchState: 'accepted' } } }
      },
      awaitSendHandedOver: async () => undefined,
      awaitSendSettlement: async () => undefined,
      awaitSendDispatched: async () => undefined,
      sessions: new Map(),
      logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }
    }),
    respond,
    subscribeTurnCompletions: (subscriber: { emit: typeof emit }) => {
      emit = subscriber.emit
      return () => {
        emit = null
      }
    },
    resolvedBy: () => 'desktop',
    now: () => 1_000
  } as unknown as StructuredAgentSessionRestoredPromptsDeps
  const prompts = new StructuredAgentSessionRestoredPrompts(deps)
  const live = vi.fn(async () => ({ ok: false as const, refusal: {} as never }))
  const answer = (optionId: string) =>
    prompts.respond(
      { callerKey: 'desktop' },
      {
        itemId: 'old',
        expectedRevision: 1,
        kind: 'approval',
        optionId,
        envelope: {
          sessionId: SESSION,
          clientOperationId: 'op-1',
          expectedRuntimeFence: 3,
          payloadFingerprint: 'fp'
        }
      },
      live
    )
  const reask = async (itemId: string, digest: string) => {
    items.set(itemId, approval(itemId, digest, 'pending'))
    emit?.({
      type: 'prompt',
      prompt: {
        sessionId: SESSION,
        promptId: itemId,
        scope: {} as never,
        journalCursor: { epoch: 'e', sequence: 10 },
        raisedAt: 2_000
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return { items, sent, respond, live, answer, reask, listening: () => emit !== null }
}

describe('answering a prompt whose agent exited before the restart', () => {
  it('records the answer, resumes the agent with it, and approves the identical request once', async () => {
    const r = rig()
    const result = await r.answer('allow')

    expect(result.ok).toBe(true)
    expect(r.live).not.toHaveBeenCalled()
    expect(r.items.get('old')!.body).toMatchObject({
      resolution: { state: 'resolved', selectedOptionId: 'allow', endedBy: 'agent_exit' }
    })
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0]).toContain('The user approved it.')
    expect(r.sent[0]).toContain('pnpm test --filter api')

    await r.reask('new', 'digest-a')
    expect(r.respond).toHaveBeenCalledTimes(1)
    expect(r.respond.mock.calls[0]![1]).toMatchObject({ itemId: 'new', optionId: 'allow' })
    expect(r.listening()).toBe(false)

    // The answer is spent: a second identical ask goes to the person.
    await r.reask('again', 'digest-a')
    expect(r.respond).toHaveBeenCalledTimes(1)
  })

  it('leaves a different request for the person to answer', async () => {
    const r = rig()
    await r.answer('allow')
    await r.reask('new', 'digest-b')

    expect(r.respond).not.toHaveBeenCalled()
    expect(r.listening()).toBe(false)
  })

  it('tells the resumed agent a denial and refuses its identical request', async () => {
    const r = rig()
    await r.answer('deny')

    expect(r.sent[0]).toContain('The user denied it.')
    await r.reask('new', 'digest-a')
    expect(r.respond.mock.calls[0]![1]).toMatchObject({ itemId: 'new', optionId: 'deny' })
  })

  it('refuses a restored card once the chat has moved on, without starting the agent', async () => {
    const r = rig()
    r.items.set('reply', {
      itemId: 'reply',
      revision: 1,
      sequence: 4,
      observedAt: 1,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'never mind' }] }
    })
    const result = await r.answer('allow')

    expect(result.ok).toBe(false)
    expect(r.sent).toHaveLength(0)
    expect(r.items.get('old')!.body).toMatchObject({ resolution: { state: 'cancelled' } })
  })
})
