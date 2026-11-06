import {
  finishTranscriptWork,
  type TranscriptWork
} from '../../../native-chat/transcript-work-scheduler'
import {
  readFirstString,
  readRecord,
  readString,
  readTextContentWork
} from '../../app-server/codex-item-field-readers'
import type { CodexThreadItem } from './codex-thread-item-identity'

export function codexCommandOutput(item: CodexThreadItem): string | null {
  return readFirstString(item, ['aggregatedOutput', 'aggregated_output'])
}

export function codexReasoningText(item: CodexThreadItem): string | null {
  return finishTranscriptWork(codexReasoningTextWork(item))
}

export function* codexReasoningTextWork(item: CodexThreadItem): TranscriptWork<string | null> {
  return (
    (yield* readTextContentWork(item, 'text')) ??
    (yield* readTextContentWork(item, 'summary')) ??
    (yield* readTextContentWork(item, 'content'))
  )
}

export function mcpToolArguments(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return value === null || value === undefined ? null : { arguments: value }
  }
  return Array.isArray(value) ? { arguments: value } : Object.keys(value).length > 0 ? value : null
}

export function mcpToolOutput(item: CodexThreadItem): string | null {
  return finishTranscriptWork(mcpToolOutputWork(item))
}

export function* mcpToolOutputWork(item: CodexThreadItem): TranscriptWork<string | null> {
  return (
    readString(readRecord(item.error), 'message') ??
    (yield* readTextContentWork(readRecord(item.result), 'content'))
  )
}
