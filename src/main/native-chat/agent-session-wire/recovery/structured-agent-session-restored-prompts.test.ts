import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalApprovalItem,
  AgentJournalRenderItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { refuse } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { AgentSessionTurnCompletionEvent } from '../../../../shared/agent-session/view/agent-session-turn-completion-wire'
import {
  StructuredAgentSessionRestoredPrompts,
  type RestoredPromptJournal,
  type StructuredAgentSessionRestoredPromptsDeps
} from './structured-agent-session-restored-prompts'
import { restoredAgentJournalPrompt } from '../../../../shared/agent-session/requests/prompts/agent-session-restored-prompt'

const SESSION = 'session-1'
const REFUSED = {
  ok: false as const,
  refusal: refuse('agent_session_operation_invalid', { reason: 'promptGone' }, 'not live')
}
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

function rig({ startRejected = false } = {}) {
  const items = new Map<string, AgentJournalRenderItem>([
    ['old', approval('old', 'digest-a', 'cancelled')]
  ])
  let emit: ((event: AgentSessionTurnCompletionEvent) => void) | null = null
  let running = false
  const sent: string[] = []
  const respond = vi.fn<StructuredAgentSessionRestoredPromptsDeps['respond']>(async () => REFUSED)
  const journal: RestoredPromptJournal = {
    reads: {
      item: async (id) => items.get(id) ?? null,
      restoredPrompt: async () => restoredAgentJournalPrompt([...items.values()]),
      cursor: async () => ({ epoch: 'e', sequence: 9 })
    },
    mutatePrompt: async (input) => {
      const current = items.get(input.itemId)!
      const body = current.body.kind === 'approval' ? current.body : null
      items.set(input.itemId, {
        ...current,
        revision: current.revision + 1,
        ...(body ? { body: { ...body, resolution: input.resolution } } : {})
      })
      return { revision: current.revision + 1 }
    }
  }
  const deps: StructuredAgentSessionRestoredPromptsDeps = {
    conversation: async () => ({ journal }),
    agentRunning: () => running,
    continuationHost: () => ({
      conversationFence: () => 3,
      now: () => 1_000,
      send: async (input) => {
        await input.beforeRun?.()
        running = true
        const block = input.body.blocks[0]
        sent.push(block?.type === 'text' ? block.text : '')
        return {
          ok: true,
          replayed: false,
          fence: 3,
          cursor: { epoch: 'e', sequence: 10 },
          value: {
            clientMessageId: input.envelope.clientOperationId,
            submission: {
              clientMessageId: input.envelope.clientOperationId,
              fence: 3,
              payloadFingerprint: 'fp',
              dispatchState: 'accepted',
              providerItemId: null,
              reason: null,
              submittedAt: 1_000,
              resolvedAt: 1_000
            }
          }
        }
      },
      awaitSendHandedOver: async (_sessionId, clientMessageId) =>
        startRejected
          ? {
              clientMessageId,
              fence: 3,
              payloadFingerprint: 'fp',
              dispatchState: 'rejected',
              providerItemId: null,
              reason: 'spawn failed',
              submittedAt: 1_000,
              resolvedAt: 1_000
            }
          : undefined,
      awaitSendSettlement: async () => undefined,
      awaitSendDispatched: async () => undefined,
      sessions: new Map(),
      logger: { warn: () => {}, error: () => {} }
    }),
    respond,
    subscribeTurnCompletions: (subscriber) => {
      emit = subscriber.emit
      return () => {
        emit = null
      }
    },
    now: () => 1_000
  }
  const prompts = new StructuredAgentSessionRestoredPrompts(deps)
  const live = vi.fn(async () => REFUSED)
  const answer = (optionId: string, expectedRevision = 1) =>
    prompts.respond(
      { callerKey: 'desktop' },
      {
        itemId: 'old',
        expectedRevision,
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
        scope: {
          workspaceId: 'w',
          executionHostId: 'local',
          wslDistro: null,
          workspaceKind: 'git-worktree'
        },
        journalCursor: { epoch: 'e', sequence: 10 },
        raisedAt: 2_000
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return {
    items,
    sent,
    respond,
    live,
    answer,
    reask,
    listening: () => emit !== null,
    agentExits: () => {
      running = false
    }
  }
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
    expect(r.respond.mock.calls[0]?.[1]).toMatchObject({ itemId: 'new', optionId: 'allow' })
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
    expect(r.respond.mock.calls[0]?.[1]).toMatchObject({ itemId: 'new', optionId: 'deny' })
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

  it('refuses a second device with a different answer instead of reporting it sent', async () => {
    const r = rig()
    await r.answer('allow')
    r.agentExits()
    const result = await r.answer('deny')

    expect(result).toMatchObject({ ok: false, refusal: { code: 'agent_session_already_resolved' } })
    expect(r.sent).toHaveLength(1)
    expect(r.items.get('old')!.body).toMatchObject({ resolution: { selectedOptionId: 'allow' } })
  })

  it('puts the card back when the agent could not be started', async () => {
    const r = rig({ startRejected: true })
    await r.answer('allow')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(r.items.get('old')!.body).toMatchObject({
      resolution: { state: 'cancelled', selectedOptionId: null, endedBy: 'agent_exit' }
    })
    await r.reask('new', 'digest-a')
    expect(r.respond).not.toHaveBeenCalled()
  })
})
