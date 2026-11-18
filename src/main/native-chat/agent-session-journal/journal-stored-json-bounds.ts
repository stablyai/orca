import { JOURNAL_READER_REPLY_BYTE_LIMIT } from './journal-sql-reader-reply-limit'

const LIMIT = JOURNAL_READER_REPLY_BYTE_LIMIT
const SHORTENED_HEAD_CHARS = 16 * 1024

/**
 * Selects stored JSON only when it fits one reader reply, so neither the reader nor main ever
 * holds a larger value; one stored item can reach hundreds of MB. An oversized value comes back
 * NULL with its size, or with `shortenColumn` (the plain column an oversized value comes from), as
 * the item with its tool output or patch head cut, keeping the original size and digest the way
 * running output is kept. `bytes` should measure plain columns: SQLite sizes those without reading
 * their text.
 */
export function boundedStoredJsonSql(
  expression: string,
  as: string,
  options: { bytes?: string; shortenColumn?: string } = {}
): string {
  const bytes = options.bytes ?? `octet_length(${expression})`
  const oversized = options.shortenColumn ? shortenedJsonSql(options.shortenColumn) : 'NULL'
  return `CASE WHEN ${bytes}<=${LIMIT} THEN ${expression} ELSE ${oversized} END AS ${as},
    ${bytes} AS ${as}_bytes`
}

/**
 * Built in SQLite's native memory, which keeps the row's parse for each JSON call; the shortened
 * item is measured itself, since escaping makes stored and extracted sizes differ.
 */
function shortenedJsonSql(json: string): string {
  const cut = (payload: string) => {
    const shortened = `json_set(${json},'${payload}.head',
      substr(json_extract(${json},'${payload}.head'),1,${SHORTENED_HEAD_CHARS}),
      '${payload}.truncated',json('true'))`
    return `WHEN json_type(${json},'${payload}.head')='text' AND octet_length(${shortened})<=${LIMIT}
      THEN ${shortened}`
  }
  return `CASE ${cut('$.body.output')} ${cut('$.body.patch')} END`
}

/** The selected JSON text, or a refusal of the read when the stored value was too large to load. */
export function boundedStoredJson(row: Record<string, unknown>, as: string): unknown {
  const bytes = row[`${as}_bytes`]
  if (typeof bytes === 'number' && bytes > LIMIT && row[as] == null) {
    throw new Error(`journal stored item (${bytes} bytes) exceeds ${LIMIT} bytes`)
  }
  return row[as]
}
