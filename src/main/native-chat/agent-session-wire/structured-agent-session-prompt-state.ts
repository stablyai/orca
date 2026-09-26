import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import { refuse, type AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'

type PendingPromptBody = Extract<AgentJournalItemBody, { kind: 'approval' | 'question' }>

export type PendingPromptValidation =
  | { ok: true; item: AgentJournalRenderItem; prompt: PendingPromptBody }
  | { ok: false; refusal: AgentSessionWireRefusal }

/** The prompt the client named is not one waiting on the user: nothing to answer. */
function promptGone(message: string): PendingPromptValidation {
  return { ok: false, refusal: refuse('agent_session_operation_invalid', 'promptGone', message) }
}

export function validatePendingPrompt(
  ctx: Pick<AgentSessionTurnContext, 'journal' | 'sessionId'>,
  input: {
    itemId: string
    expectedRevision: number
    kind?: 'approval' | 'question'
  }
): PendingPromptValidation {
  const item = ctx.journal.snapshot().items.find((entry) => entry.itemId === input.itemId)
  if (!item) {
    return promptGone(`No item ${input.itemId} in session ${ctx.sessionId}.`)
  }
  const prompt = item.body.kind === 'approval' || item.body.kind === 'question' ? item.body : null
  if (!prompt || (input.kind !== undefined && prompt.kind !== input.kind)) {
    return promptGone(
      `Item ${input.itemId} is not a pending${input.kind ? ` ${input.kind}` : ' prompt'}.`
    )
  }
  if (item.revision !== input.expectedRevision) {
    return {
      ok: false,
      refusal: {
        code: 'agent_session_item_revision_stale',
        cause: 'promptMoved',
        message: `Item ${input.itemId} has moved on.`,
        currentRevision: item.revision,
        resolution: prompt.resolution
      }
    }
  }
  if (prompt.resolution.state !== 'pending') {
    return {
      ok: false,
      refusal: {
        code: 'agent_session_already_resolved',
        cause: 'promptAlreadyResolved',
        message: `Item ${input.itemId} was already ${prompt.resolution.state}.`,
        currentRevision: item.revision,
        resolution: prompt.resolution
      }
    }
  }
  return { ok: true, item, prompt }
}
