import { createHash } from 'node:crypto'
import {
  parseAgentJournalItemKey,
  agentJournalItemKey
} from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'

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

export type CodexGoalAccounting = {
  key: string
  timeUsedSeconds: number
  tokenBudget: number | null
}

export function codexGoalAccounting(
  body: AgentJournalItemBody | undefined
): CodexGoalAccounting | null {
  if (body?.kind !== 'status' || body.threadGoal?.state !== 'set') {
    return null
  }
  const { tokenBudget, tokensUsed, timeUsedSeconds, updatedAt } = body.threadGoal.goal
  return {
    key: JSON.stringify([tokenBudget, tokensUsed, timeUsedSeconds, updatedAt]),
    timeUsedSeconds,
    tokenBudget
  }
}

export type CodexGoalRowChoice = {
  thread: string
  signature: string
  body: AgentJournalItemBody
  /** A cleared snapshot writes only after a saved goal. */
  requirePrevious: boolean
}

/** Choose the row against the thread's newest saved goal row; null writes nothing. */
export function resolveCodexGoalIdentity(
  newestWithKeyPrefix: (prefix: string) => AgentJournalRenderItem | null,
  choice: CodexGoalRowChoice
): AgentJournalItemIdentity | null {
  const { thread, signature } = choice
  const newest = newestWithKeyPrefix(
    agentJournalItemKey({ provider: 'orca', clientMessageId: `${GOAL_IDENTITY_PREFIX}:${thread}:` })
  )
  const previous = newest ? parseCodexGoalJournalItemId(newest.itemId) : null
  if (previous?.signature === signature) {
    const accounting = codexGoalAccounting(choice.body)
    return accounting === null || codexGoalAccounting(newest?.body)?.key === accounting.key
      ? null
      : codexGoalJournalIdentity(thread, signature, previous.occurrence)
  }
  // Codex sends a cleared snapshot while resuming threads that never had a goal.
  if (previous === null && choice.requirePrevious) {
    return null
  }
  const occurrence = previous
    ? codexGoalJournalDigest(JSON.stringify([previous.occurrence, signature]))
    : codexGoalJournalDigest(JSON.stringify([thread, signature]))
  return codexGoalJournalIdentity(thread, signature, occurrence)
}
