import { z } from 'zod'
import { readRecord } from '../codex/app-server/codex-item-field-readers'

const envelope = z.looseObject({
  sessionId: z.string(),
  update: z.looseObject({ sessionUpdate: z.string() })
})
const HISTORY_TOOL_OUTPUT = 'Full historical tool output is retained in the TRAE CLI session log.'
const INPUT_FIELDS = ['command', 'cmd', 'file_path', 'path', 'url', 'query', 'description'] as const

function historicalInput(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.slice(0, 256)
  }
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const input = readRecord(value)
  return Object.fromEntries(
    INPUT_FIELDS.flatMap((key) =>
      typeof input[key] === 'string' ? [[key, input[key].slice(0, 256)]] : []
    )
  )
}

export function projectTraeHistoryFrame(_method: string, params: unknown): unknown {
  const parsed = envelope.safeParse(params)
  if (!parsed.success || parsed.data.update.sessionUpdate !== 'tool_call') {
    return params
  }
  const { update } = parsed.data
  return {
    sessionId: parsed.data.sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: update.toolCallId,
      title: typeof update.title === 'string' ? update.title.slice(0, 256) : undefined,
      kind: update.kind,
      status: update.status,
      rawInput: historicalInput(update.rawInput),
      rawOutput: HISTORY_TOOL_OUTPUT
    }
  }
}
