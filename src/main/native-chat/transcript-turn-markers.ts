// Shared detection of provider-authored turn boundaries. The message decoders
// render a visible status row from these lines; the lifecycle decoders settle
// the chat spinner from the same lines. Keeping the predicates here means the
// two consumers can never disagree about which JSONL line is an interrupt/abort
// or a turn boundary — updating a provider's format touches one place, so a
// rename can't leave a visible "interrupted" row that never settles (or vice
// versa). Codex's markers live in src/shared/codex-rollout-turn-lifecycle.ts,
// because the hook lane reads them from the rollout too.

import { extractString } from '../ai-vault/session-scanner-values'

/**
 * The `interruptedMessageId` on a Claude user row when that row is Claude's
 * injected interrupt notice rather than a real user prompt. Returns undefined
 * for genuine user turns.
 */
export function claudeInterruptedMessageId(record: Record<string, unknown>): string | undefined {
  if (record.type !== 'user') {
    return undefined
  }
  return extractString(record.interruptedMessageId) ?? undefined
}
