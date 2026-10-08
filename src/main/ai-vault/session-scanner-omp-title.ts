import { extractString, normalizeTitleText, timestampMs } from './session-scanner-values'

export type OmpTranscriptTitle = {
  title: string
  source: 'user' | 'auto'
  updatedAt: number | null
}

/** Fold persisted title metadata; a current slot can precede older rename entries. */
export function foldOmpTranscriptTitle(
  current: OmpTranscriptTitle | null,
  record: Record<string, unknown>
): OmpTranscriptTitle | null {
  const legacy = record.type === 'session_info'
  if (
    !legacy &&
    record.type !== 'session' &&
    record.type !== 'title_change' &&
    record.type !== 'title'
  ) {
    return current
  }
  if (record.type === 'title' && record.v !== 1) {
    return current
  }
  const title = normalizeTitleText(extractString(legacy ? record.name : record.title) ?? '')
  if (!title) {
    return current
  }
  const rawSource = legacy ? 'user' : (record.source ?? record.titleSource)
  if (rawSource !== undefined && rawSource !== 'user' && rawSource !== 'auto') {
    return current
  }
  const source = rawSource === 'user' ? 'user' : 'auto'
  if (current?.source === 'user' && source !== 'user') {
    return current
  }
  const timestamp = timestampMs(record.type === 'title' ? record.updatedAt : record.timestamp)
  const updatedAt = Number.isFinite(timestamp) ? timestamp : null
  if (
    current?.source === source &&
    current.updatedAt !== null &&
    updatedAt !== null &&
    updatedAt < current.updatedAt
  ) {
    return current
  }
  return { title, source, updatedAt }
}
