/** Newline JSON between the structured adapter and the Cursor SDK sidecar. */

export type CursorSdkModelSelection = {
  id: string
  params?: { id: string; value: string }[]
}

export type CursorSdkImage = { data: string; mimeType: string } | { url: string }

export type CursorSidecarStart = {
  type: 'start'
  cwd: string
  storeDir: string
  apiKey?: string
  agentId?: string
  model: CursorSdkModelSelection
  mode: 'agent' | 'plan'
  sandbox: boolean
  autoReview: boolean
}

export type CursorSidecarCommand =
  | CursorSidecarStart
  | {
      type: 'send'
      text: string
      images?: CursorSdkImage[]
      model?: CursorSdkModelSelection
      mode?: 'agent' | 'plan'
    }
  | { type: 'steer'; text: string; id: number }
  | { type: 'cancel' }
  | { type: 'dispose' }

export type CursorSidecarEvent =
  | { type: 'ready'; agentId: string }
  | { type: 'loginUrl'; url: string }
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'task'; text: string }
  | {
      type: 'tool'
      callId: string
      name: string
      status: 'running' | 'completed' | 'error'
      args?: unknown
      result?: unknown
    }
  | {
      type: 'usage'
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
      cacheWriteTokens: number
      totalTokens: number
    }
  | { type: 'steer'; id: number; outcome: 'complete_delivered' | 'revert_to_followup' }
  | {
      type: 'result'
      status: 'finished' | 'error' | 'cancelled'
      result?: string
      error?: string
      durationMs?: number
    }
  | { type: 'startupError'; message: string; code?: string }
  | { type: 'exited'; code: number | null }

export type CursorSdkListedModel = {
  id: string
  displayName: string
  description?: string
  parameters?: {
    id: string
    displayName?: string
    values: { value: string; displayName?: string }[]
  }[]
  variants?: {
    isDefault?: boolean
    params: { id: string; value: string }[]
  }[]
}

export function parseCursorSidecarEvent(line: string): CursorSidecarEvent | null {
  try {
    const value: unknown = JSON.parse(line)
    if (typeof value !== 'object' || value === null || !('type' in value)) {
      return null
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the line is one JSON object with a type field; listeners ignore shapes they do not handle.
    return value as CursorSidecarEvent
  } catch {
    return null
  }
}
