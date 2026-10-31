import {
  readFirstString,
  readRecord,
  readString,
  readTextContent
} from './codex-item-field-readers'
import type { CodexThreadItem } from './codex-thread-item-identity'

export function codexCommandOutput(item: CodexThreadItem): string | null {
  return readFirstString(item, ['aggregatedOutput', 'aggregated_output'])
}

export function codexReasoningText(item: CodexThreadItem): string | null {
  return (
    readTextContent(item, 'text') ??
    readTextContent(item, 'summary') ??
    readTextContent(item, 'content')
  )
}

export function mcpToolArguments(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return value === null || value === undefined ? null : { arguments: value }
  }
  return Array.isArray(value) ? { arguments: value } : Object.keys(value).length > 0 ? value : null
}

export function mcpToolOutput(item: CodexThreadItem): string | null {
  return (
    readString(readRecord(item.error), 'message') ??
    readTextContent(readRecord(item.result), 'content')
  )
}
