import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { cancelClaudeTurn } from './claude-structured-control-actions'
import type { ClaudeSession } from './claude-structured-session-state'

type CancelTurnInput = Parameters<StructuredAgentSessionAdapter['cancelTurn']>[0]

export async function cancelClaudeStructuredTurn(input: {
  session: ClaudeSession
  request: CancelTurnInput
  requestTimeoutMs?: number
  stillOwnsTurn: () => boolean
  emitPromptCancelled: (
    promptKey: string,
    settlement?: { settlementId: string; resolvedBy?: string; resolvedAt?: number }
  ) => void
}): Promise<{ cancelled: boolean }> {
  const { session, request } = input
  const prompt = request.promptItemId
    ? session.prompts.beginHostCancellation(request.promptItemId, request.turnId)
    : null
  if (request.promptItemId && !prompt) {
    return { cancelled: false }
  }
  let cancelled = false
  try {
    const result = await cancelClaudeTurn(session, input.requestTimeoutMs, () => {
      return (
        input.stillOwnsTurn() &&
        (!request.promptItemId ||
          session.prompts.cancellation(request.promptItemId)?.turnId === request.turnId)
      )
    })
    cancelled = result.cancelled
  } finally {
    if (prompt && session.prompts.finishHostCancellation(prompt, cancelled)) {
      cancelled = true
      input.emitPromptCancelled(
        prompt.promptKey,
        request.promptCancellationId
          ? {
              settlementId: request.promptCancellationId,
              ...(request.promptCancellationResolvedBy
                ? { resolvedBy: request.promptCancellationResolvedBy }
                : {}),
              ...(request.promptCancellationResolvedAt !== undefined
                ? { resolvedAt: request.promptCancellationResolvedAt }
                : {})
            }
          : undefined
      )
    }
  }
  return { cancelled }
}
