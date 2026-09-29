import type { AiVaultSessionPreviewMessage } from '../../shared/ai-vault-types'
import { asRecord } from './session-scanner-record-value'
import { parseJsonObject } from './session-scanner-values'
import { transcriptMessagesFromContent } from './session-transcript-message-content'

export function extractOpenCode2MessageText(data: string): string | null {
  const record = parseJsonObject(data)
  if (typeof record?.text === 'string') {
    return record.text
  }
  if (Array.isArray(record?.text)) {
    return record.text.filter((part): part is string => typeof part === 'string').join('\n') || null
  }
  if (!Array.isArray(record?.content)) {
    return null
  }
  return (
    record.content
      .flatMap((value) => {
        const item = asRecord(value)
        return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : []
      })
      .join('\n') || null
  )
}

export function decodeOpenCode2Message(
  data: string,
  role: AiVaultSessionPreviewMessage['role'],
  timestamp: string | null
) {
  const record = parseJsonObject(data)
  const content = Array.isArray(record?.content)
    ? record.content.flatMap((value) => {
        const item = asRecord(value)
        if (item?.type !== 'tool') {
          return [value]
        }
        const state = asRecord(item.state)
        return [
          { type: 'tool_use', name: item.name, input: state?.input },
          { type: 'tool_result', content: state?.content }
        ]
      })
    : record?.text
  return transcriptMessagesFromContent(role, content, timestamp)
}

export function parseOpenCode2MessageRow(value: unknown) {
  const row = asRecord(value)
  if (
    typeof row?.data !== 'string' ||
    typeof row.type !== 'string' ||
    typeof row.time_created !== 'number'
  ) {
    throw new Error('OpenCode 2 transcript contains an invalid message')
  }
  return { data: row.data, type: row.type, time_created: row.time_created }
}
