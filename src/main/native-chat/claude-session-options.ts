import type { AgentType } from '../../shared/agent-status-types'

export type ClaudeSessionOptions = {
  fastMode: boolean
  recordedAt: number | null
}

export function parseClaudeSessionOptionsRecord(
  agent: AgentType,
  line: string
): ClaudeSessionOptions | null {
  if (agent !== 'claude' && agent !== 'openclaude') {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }
  const record = parsed as Record<string, unknown>
  const message =
    typeof record.message === 'object' && record.message !== null
      ? (record.message as Record<string, unknown>)
      : null
  const content = typeof message?.content === 'string' ? message.content.trim() : ''
  const match = /^<local-command-stdout>Fast mode (ON|OFF)<\/local-command-stdout>$/.exec(content)
  if (!match) {
    return null
  }
  const timestamp = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN
  return {
    fastMode: match[1] === 'ON',
    recordedAt: Number.isFinite(timestamp) ? timestamp : null
  }
}
