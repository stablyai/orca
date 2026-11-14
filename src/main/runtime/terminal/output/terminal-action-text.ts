import {
  getTerminalLineOrigins,
  setTerminalLineOrigins,
  joinedTerminalOrigins,
  terminalSupportQuery,
  lowercaseTerminalSupport,
  type TerminalOriginRuns,
  type TerminalSupportQuery,
  type TerminalContentOrigin
} from '../../../../shared/terminal/output/terminal-content-origin'
import type { TerminalCommandPaintRecord } from '../input/terminal-command-paint'

export type ActionTextRecord = TerminalCommandPaintRecord & {
  tailBuffer: string[]
  tailPartialLine: string
  preview: string
  tailPartialOrigins?: TerminalOriginRuns
}
export type TerminalActionText = {
  text: string
  origins?: TerminalOriginRuns
  query?: TerminalSupportQuery
  lower: string
  lowerQuery?: TerminalSupportQuery
}
type CachedText = {
  lines: string[]
  partial: string
  partialOrigins?: TerminalOriginRuns
  preview: string
  origins?: readonly TerminalOriginRuns[]
  paint: ActionTextRecord['commandPaint']
  epoch: number
  value: TerminalActionText
}
const views = new WeakMap<ActionTextRecord, CachedText>()

/** Each projection owns its text and certificates; it must not populate a stable record's cache. */
export function buildTerminalActionText(
  lines: readonly string[],
  scope?: TerminalContentOrigin
): TerminalActionText {
  const joined = joinedTerminalOrigins(lines, true)
  const query = terminalSupportQuery(joined.origins, scope)
  const lower = lowercaseTerminalSupport(joined.text, query)
  return {
    text: joined.text,
    origins: joined.origins,
    query,
    lower: lower.text,
    lowerQuery: lower.query
  }
}

/** One bounded action view shared by readers; history and pagination keep the original strings. */
export function readTerminalActionText(
  record: ActionTextRecord,
  fallback?: () => string
): TerminalActionText {
  if (fallback && !getTerminalLineOrigins(record.tailBuffer) && !record.tailPartialOrigins) {
    const text = fallback()
    return { text, lower: text.toLowerCase() }
  }
  const cached = views.get(record)
  const epoch = record.commandPaint?.commandEpoch ?? 0
  const origins = getTerminalLineOrigins(record.tailBuffer)
  if (
    cached?.lines === record.tailBuffer &&
    cached.partial === record.tailPartialLine &&
    cached.partialOrigins === record.tailPartialOrigins &&
    cached.preview === record.preview &&
    cached.paint === record.commandPaint &&
    cached.epoch === epoch &&
    cached.origins === origins
  ) {
    return cached.value
  }
  const lines = record.tailPartialLine
    ? [...record.tailBuffer, record.tailPartialLine]
    : record.tailBuffer
  if (lines !== record.tailBuffer && (origins || record.tailPartialOrigins)) {
    setTerminalLineOrigins(lines, [
      ...(origins ?? record.tailBuffer.map(() => [])),
      record.tailPartialOrigins ?? []
    ])
  }
  const joined = joinedTerminalOrigins(lines, true)
  const attributed = !!(origins || record.tailPartialOrigins) && epoch > 0
  const text = joined.text || (attributed ? '' : record.preview)
  const query = joined.text
    ? terminalSupportQuery(joined.origins, record.commandPaint?.contentOrigin)
    : attributed
      ? () => false
      : undefined
  const lower = lowercaseTerminalSupport(text, query)
  const value = { text, origins: joined.origins, query, lower: lower.text, lowerQuery: lower.query }
  views.set(record, {
    lines: record.tailBuffer,
    partial: record.tailPartialLine,
    partialOrigins: record.tailPartialOrigins,
    preview: record.preview,
    origins,
    paint: record.commandPaint,
    epoch,
    value
  })
  return value
}
