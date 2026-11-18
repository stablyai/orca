import type { Query } from '@anthropic-ai/claude-agent-sdk'

/** Claude's answer to `remote_control` enabled:true; enabled:false answers nothing. */
export type ClaudeRemoteControlAnswer = { sessionUrl?: string }

// enableRemoteControl sends `remote_control` but is absent from Query's declaration.
export function claudeQueryRemoteControl(
  query: Query
): ((enabled: boolean) => Promise<ClaudeRemoteControlAnswer>) | null {
  const send = 'enableRemoteControl' in query ? query.enableRemoteControl : null
  return typeof send === 'function'
    ? async (enabled) => readClaudeRemoteControlAnswer(await send.call(query, enabled))
    : null
}

function readClaudeRemoteControlAnswer(answer: unknown): ClaudeRemoteControlAnswer {
  const fields = typeof answer === 'object' && answer !== null ? answer : {}
  const sessionUrl = 'session_url' in fields ? fields.session_url : undefined
  return typeof sessionUrl === 'string' && sessionUrl.startsWith('https://') ? { sessionUrl } : {}
}
