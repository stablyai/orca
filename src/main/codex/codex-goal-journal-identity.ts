import { createHash } from 'node:crypto'
import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'

export type CodexGoalJournalState = {
  thread: string
  signature: string
  occurrence: string
}

const GOAL_IDENTITY_PREFIX = 'codex-goal'
const DIGEST_PATTERN = /^[0-9a-f]{64}$/

export function codexGoalJournalDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function codexGoalJournalIdentity(
  thread: string,
  signature: string,
  occurrence: string
): AgentJournalItemIdentity {
  return {
    provider: 'orca',
    clientMessageId: `${GOAL_IDENTITY_PREFIX}:${thread}:${signature}:${occurrence}`
  }
}

/** Recognizes only the host-owned rows used to record Codex goal lifecycle state. */
export function parseCodexGoalJournalItemId(itemId: string): CodexGoalJournalState | null {
  const identity = parseAgentJournalItemKey(itemId)
  if (identity?.provider !== 'orca') {
    return null
  }
  const [prefix, thread, signature, occurrence, ...rest] = identity.clientMessageId.split(':')
  return prefix === GOAL_IDENTITY_PREFIX &&
    DIGEST_PATTERN.test(thread ?? '') &&
    DIGEST_PATTERN.test(signature ?? '') &&
    DIGEST_PATTERN.test(occurrence ?? '') &&
    rest.length === 0
    ? {
        thread: thread as string,
        signature: signature as string,
        occurrence: occurrence as string
      }
    : null
}
