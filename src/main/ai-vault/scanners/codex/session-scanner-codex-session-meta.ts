import { extractString } from '../../../../shared/trimmed-string'
import { normalizeTitleText } from '../../parsing/session-scanner-text-normalization'

export function extractCodexSessionMetadataTitle(payload: Record<string, unknown>): string | null {
  return (
    normalizeTitleText(extractString(payload.title) ?? '') ??
    normalizeTitleText(extractString(payload.thread_name) ?? '') ??
    normalizeTitleText(extractString(payload.threadName) ?? '')
  )
}
