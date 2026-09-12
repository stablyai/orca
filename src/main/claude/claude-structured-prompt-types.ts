export type ClaudePromptSettle = (response: Record<string, unknown> | null) => void

export type ClaudePendingPrompt = {
  requestId: string
  promptKey: string
  turnId?: string | null
  toolUseId: string
  toolName: string
  kind: 'approval' | 'question'
  input: Record<string, unknown>
  suggestions: unknown[]
  questionIds: readonly string[]
  answers: Map<string, string | readonly string[]>
  settle: ClaudePromptSettle
}

export type ClaudePromptRegistration = {
  requestId: string
  turnId?: string | null
  toolName: string
  toolUseId: string
  input: Record<string, unknown>
  suggestions: unknown[]
  settle: ClaudePromptSettle
}
