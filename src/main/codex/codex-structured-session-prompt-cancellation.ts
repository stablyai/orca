import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { CodexSession } from './codex-structured-session-state'
import type { CodexStructuredTurnCancellation } from './codex-structured-turn-cancellation'

type CancelTurnInput = Parameters<StructuredAgentSessionAdapter['cancelTurn']>[0]

export async function cancelCodexStructuredSessionTurn(args: {
  input: CancelTurnInput
  session: CodexSession
  providerTurnId: string | undefined
  turnCancellation: CodexStructuredTurnCancellation
}): Promise<{ cancelled: boolean }> {
  const { input, session, providerTurnId: turnId } = args
  const prompt = input.promptItemId ? session.prompts.find(input.promptItemId) : null
  const threadId = input.threadId ?? session.threadId
  if (
    !turnId ||
    (input.promptItemId && (prompt?.turnId !== turnId || prompt.threadId !== threadId))
  ) {
    return { cancelled: false }
  }
  const result = await args.turnCancellation.cancel(
    session,
    threadId,
    turnId,
    input.promptCancellationId
      ? {
          settlementId: input.promptCancellationId,
          ...(input.promptCancellationResolvedBy
            ? { resolvedBy: input.promptCancellationResolvedBy }
            : {}),
          ...(input.promptCancellationResolvedAt !== undefined
            ? { resolvedAt: input.promptCancellationResolvedAt }
            : {})
        }
      : undefined,
    prompt ? () => session.prompts.forget(prompt) : undefined
  )
  if (result.cancelled && prompt) {
    session.prompts.forget(prompt)
  }
  return result
}
