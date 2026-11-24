import { JOURNAL_READER_REPLY_BYTE_LIMIT } from './journal-sql-reader-reply-limit'

const LIMIT = JOURNAL_READER_REPLY_BYTE_LIMIT
const SHORTENED_HEAD_CHARS = 16 * 1024

/**
 * Selects stored JSON only when it fits one reader reply, so neither the reader nor main ever
 * holds a larger value; one stored item can reach hundreds of MB. An oversized value comes back
 * NULL with its size, or with `shortenColumn` (the plain column an oversized value comes from), as
 * the item with its tool output or patch head cut, keeping the original size and digest the way
 * running output is kept. Shortening starts at half the limit: a reply serializes any character
 * past U+00FF as two bytes, so only a value under half always fits it. `bytes` should measure plain
 * columns: SQLite sizes those without reading their text.
 */
export function boundedStoredJsonSql(
  expression: string,
  as: string,
  options: { bytes?: string; shortenColumn?: string } = {}
): string {
  const bytes = options.bytes ?? `octet_length(${expression})`
  const value = options.shortenColumn
    ? `CASE WHEN ${bytes}<=${LIMIT / 2} THEN ${expression}
      ELSE COALESCE(${shortenedJsonSql(options.shortenColumn)},
        CASE WHEN ${bytes}<=${LIMIT} THEN ${expression} END) END`
    : `CASE WHEN ${bytes}<=${LIMIT} THEN ${expression} END`
  return `${value} AS ${as},
    ${bytes} AS ${as}_bytes`
}

/**
 * Built once in SQLite's native memory (the subquery keeps one copy), then measured itself, since
 * escaping makes stored and extracted sizes differ.
 */
export function shortenedJsonSql(json: string, maxBytes = LIMIT / 2): string {
  const cut = (payload: string) => `WHEN json_type(${json},'${payload}.head')='text'
    THEN json_set(${json},'${payload}.head',
      substr(json_extract(${json},'${payload}.head'),1,${SHORTENED_HEAD_CHARS}),
      '${payload}.truncated',json('true'))`
  return `(SELECT CASE WHEN octet_length(shortened)<=${maxBytes} THEN shortened END
    FROM (SELECT CASE ${cut('$.body.output')} ${cut('$.body.patch')} END AS shortened LIMIT 1))`
}

export class JournalStoredJsonSizeError extends Error {}

/** The selected JSON text, or a refusal of the read when the stored value was too large to load. */
export function boundedStoredJson(row: Record<string, unknown>, as: string): unknown {
  const bytes = row[`${as}_bytes`]
  if (typeof bytes === 'number' && bytes > LIMIT && row[as] == null) {
    throw new JournalStoredJsonSizeError(
      `journal stored item (${bytes} bytes) exceeds ${LIMIT} bytes`
    )
  }
  return row[as]
}
