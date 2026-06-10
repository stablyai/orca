// Event shapes emitted by `claude --output-format stream-json --verbose`.
// Only the fields we render are typed; unknown fields are tolerated.

export type ContentBlockText = { type: 'text'; text: string }
export type ContentBlockToolUse = { type: 'tool_use'; id: string; name: string; input: unknown }
export type ContentBlockToolResult = {
  type: 'tool_result'
  tool_use_id: string
  content: unknown
  is_error?: boolean
}
export type ContentBlock =
  | ContentBlockText
  | ContentBlockToolUse
  | ContentBlockToolResult
  | { type: string; [k: string]: unknown }

export type SystemInitEvent = {
  type: 'system'
  subtype: 'init'
  session_id: string
  model?: string
  cwd?: string
  tools?: string[]
}
export type AssistantEvent = {
  type: 'assistant'
  message: { id?: string; role: 'assistant'; content: ContentBlock[] }
  session_id?: string
}
export type UserEvent = {
  type: 'user'
  message: { role: 'user'; content: ContentBlock[] }
  session_id?: string
}
export type ResultEvent = {
  type: 'result'
  subtype?: string
  result?: string
  is_error?: boolean
  session_id?: string
}
export type ClaudeStreamEvent =
  | SystemInitEvent
  | AssistantEvent
  | UserEvent
  | ResultEvent
  | { type: string; [k: string]: unknown }

// What we send TO claude on stdin (stream-json input format):
export type UserInputMessage = {
  type: 'user'
  message: { role: 'user'; content: [{ type: 'text'; text: string }] }
}

export function userInputLine(text: string): string {
  const msg: UserInputMessage = {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] }
  }
  return `${JSON.stringify(msg)}\n`
}
