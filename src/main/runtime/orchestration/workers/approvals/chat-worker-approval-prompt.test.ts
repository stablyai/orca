import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalApprovalItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'

const hostRef: { current: unknown } = { current: null }

vi.mock(
  '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry',
  () => ({
    getStructuredAgentSessionHost: () => hostRef.current
  })
)

const { answerChatWorkerApproval, ORCHESTRATION_APPROVAL_CALLER_PREFIX } =
  await import('./chat-worker-approval-prompt')

const OURS = `${ORCHESTRATION_APPROVAL_CALLER_PREFIX}ctx_1`

function approval(resolvedBy: string | null, selected = 'deny'): AgentJournalApprovalItem {
  return {
    kind: 'approval',
    title: 'Allow Bash?',
    detail: null,
    options: [
      { id: 'allow', label: 'Allow', intent: 'allow_once' },
      { id: 'deny', label: 'Deny', intent: 'reject_once' }
    ],
    resolution: resolvedBy
      ? { state: 'resolved', selectedOptionId: selected, resolvedBy, resolvedAt: 2 }
      : { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  }
}

/** A chat whose prompt answer reports the resolution already on record, as a same-option retry does. */
function host(recordedBy: string) {
  const respondToPrompt = vi.fn(async () => ({
    ok: true as const,
    value: {
      itemId: 'item_1',
      revision: 2,
      resolution: approval(recordedBy).resolution
    }
  }))
  hostRef.current = {
    deps: { store: { getConversation: () => ({ currentFence: 1 }) } },
    respondToPrompt
  }
  return respondToPrompt
}

const answer = (body: AgentJournalApprovalItem | Error) =>
  answerChatWorkerApproval({
    sessionId: 'session_1',
    approvalId: 'item_1',
    dispatchId: 'ctx_1',
    decision: 'deny',
    readPrompt: async () => {
      if (body instanceof Error) {
        throw body
      }
      return { revision: 1, body }
    }
  })

describe('answering a chat worker approval', () => {
  it("does not claim a same-option deny someone else recorded in the worker's chat", async () => {
    host('desktop-renderer')
    expect(await answer(approval(null))).toMatchObject({ ok: false, code: 'approval_not_open' })
  })

  it('takes its own recorded answer as success, and a retry of it without a second answer', async () => {
    host(OURS)
    expect(await answer(approval(null))).toMatchObject({ ok: true, optionLabel: 'Deny' })
    const respond = host(OURS)
    expect(await answer(approval(OURS))).toMatchObject({ ok: true, optionLabel: 'Deny' })
    expect(respond).not.toHaveBeenCalled()
  })

  it('refuses, rather than calls closed, a prompt it could not read', async () => {
    const respond = host(OURS)
    expect(await answer(new Error('unreadable'))).toMatchObject({
      ok: false,
      code: 'approval_refused'
    })
    expect(respond).not.toHaveBeenCalled()
  })
})
