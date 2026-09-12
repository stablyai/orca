import { isBoundedAgentSessionOperationProviderId } from '../../shared/agent-session-operation-ledger'
import { MAX_CODEX_PROMPT_REGISTRY_BYTES } from './codex-prompt-registry-bounds'
import type { CodexPendingPrompt } from './codex-structured-prompt-replies'

export function bindCodexPromptCancellationTurn(
  prompt: CodexPendingPrompt,
  threadId: string,
  turnId: string | null | undefined,
  retainedPromptBytes: number
): void {
  if (
    prompt.turnId !== null ||
    !isBoundedAgentSessionOperationProviderId(turnId) ||
    prompt.threadId !== threadId
  ) {
    return
  }
  if (retainedPromptBytes + Buffer.byteLength(turnId, 'utf8') <= MAX_CODEX_PROMPT_REGISTRY_BYTES) {
    prompt.turnId = turnId
  }
}

export function codexPromptCancellationForItem(
  journalItemId: string,
  prompt: CodexPendingPrompt | null,
  boundPrompts: ReadonlyMap<string, CodexPendingPrompt>
): { threadId: string; turnId: string; itemIds: readonly string[] } | null {
  if (!prompt?.turnId || boundPrompts.get(journalItemId) !== prompt) {
    return null
  }
  return {
    threadId: prompt.threadId,
    turnId: prompt.turnId,
    itemIds: [...boundPrompts]
      .filter(([, candidate]) => candidate === prompt)
      .map(([itemId]) => itemId)
  }
}
