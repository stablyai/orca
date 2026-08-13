import { applyClaudePromptAnswer } from './claude-structured-prompt-replies'
import { ClaudeControlRequestError } from './claude-stream-json-connection'
import type { ClaudeSession } from './claude-structured-session-state'

export async function cancelClaudeTurn(
  session: ClaudeSession,
  timeoutMs: number | undefined
): Promise<{ cancelled: boolean }> {
  try {
    await session.connection.request('interrupt', {}, { timeoutMs })
    return { cancelled: true }
  } catch (error) {
    if (error instanceof ClaudeControlRequestError) {
      return { cancelled: false }
    }
    throw error
  }
}

export async function answerClaudePrompt(
  session: ClaudeSession,
  input: { itemId: string; kind: 'approval' | 'question'; optionId: string }
): Promise<void> {
  const found = session.prompts.find(input.itemId)
  if (!found || found.prompt.kind !== input.kind) {
    throw new Error(`claude is no longer waiting on ${input.itemId}`)
  }
  const response = applyClaudePromptAnswer(found, input.optionId)
  if (response === null) {
    return
  }
  session.prompts.forget(found.prompt)
  await session.connection.respond(found.prompt.requestId, response)
}
