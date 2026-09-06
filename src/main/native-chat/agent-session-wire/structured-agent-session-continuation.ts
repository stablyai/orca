import { buildAgentSessionContinuationPrompt } from '../../../shared/agent-session-continuation'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalMessageItem,
  AgentJournalSnapshot
} from '../../../shared/agent-session-journal-types'

const CAPTURE_LIMIT = 36_000
const SWITCH_READY_PREFIX = 'provider-switch-ready:'
const SWITCH_PREFIX = 'provider-switch:'

function providerSwitchFence(clientMessageId: string): number | null {
  const prefix = clientMessageId.startsWith(SWITCH_READY_PREFIX)
    ? SWITCH_READY_PREFIX
    : clientMessageId.startsWith(SWITCH_PREFIX)
      ? SWITCH_PREFIX
      : null
  if (!prefix) {
    return null
  }
  const fence = Number(clientMessageId.slice(prefix.length))
  return Number.isFinite(fence) ? fence : null
}

export function withStructuredSessionContinuation(
  snapshot: AgentJournalSnapshot,
  clientMessageId: string,
  body: AgentJournalMessageItem
): AgentJournalMessageItem {
  const boundary = snapshot.items.findLastIndex((item) => {
    const identity = parseAgentJournalItemKey(item.itemId)
    return identity?.provider === 'orca' && providerSwitchFence(identity.clientMessageId) !== null
  })
  if (boundary === -1) {
    return body
  }
  const identity = parseAgentJournalItemKey(snapshot.items[boundary]!.itemId)
  const switchFence =
    identity?.provider === 'orca' ? providerSwitchFence(identity.clientMessageId) : null
  if (switchFence === null) {
    return body
  }
  if (
    snapshot.submissions.some(
      (submission) =>
        submission.clientMessageId !== clientMessageId &&
        submission.fence >= switchFence &&
        submission.dispatchState === 'accepted'
    )
  ) {
    return body
  }
  const parts: string[] = []
  let remaining = CAPTURE_LIMIT
  for (let index = boundary - 1; index >= 0 && remaining > 0; index--) {
    const item = snapshot.items[index]!.body
    if (item.kind !== 'message' && item.kind !== 'tool-call' && item.kind !== 'diff') {
      continue
    }
    const text = JSON.stringify(item).slice(-remaining)
    parts.unshift(text)
    remaining -= text.length + 1
  }
  const prompt = buildAgentSessionContinuationPrompt(
    {
      sourceAgent: null,
      capturedText: parts.join('\n')
    },
    'focused'
  )
  return prompt
    ? {
        ...body,
        blocks: [{ type: 'text', text: prompt }, ...body.blocks]
      }
    : body
}
