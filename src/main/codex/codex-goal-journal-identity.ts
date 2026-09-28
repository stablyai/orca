import { createHash } from 'node:crypto'
import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import { codexGoalGeneration, codexGoalRowSignature } from './codex-goal-journal-rows'

export {
  parseCodexGoalJournalItemId,
  type CodexGoalJournalState
} from '../../shared/codex-goal-journal-identity'

export function codexGoalJournalDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function codexGoalJournalSignature(method: string, payload: unknown): string | null {
  const signature = codexGoalRowSignature(method, payload)
  if (signature === null) {
    return null
  }
  const generation = codexGoalGeneration(payload)
  const providerGeneration =
    generation === null ? null : codexGoalJournalDigest(`provider:${generation}`)
  return codexGoalJournalDigest(`${signature}\u0000${providerGeneration ?? ''}`)
}

export function codexGoalJournalIdentity(
  thread: string,
  signature: string,
  occurrence: string
): AgentJournalItemIdentity {
  return {
    provider: 'orca',
    clientMessageId: `codex-goal:${thread}:${signature}:${occurrence}`
  }
}
