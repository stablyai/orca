import type { AgentType } from '../../shared/agent-status-types'
import { isRecord } from '../../shared/agent-status-child-work-value-guards'

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
  if (!isRecord(parsed)) {
    return null
  }
  const record = parsed
  const message = isRecord(record.message) ? record.message : null
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
