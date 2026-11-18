import { JOURNAL_READER_REPLY_BYTE_LIMIT } from './journal-sql-reader-reply-limit'

/**
 * Selects stored JSON only when it fits one reader reply. A larger value comes back NULL with its
 * size, so neither the reader nor main ever holds it; one stored item can reach hundreds of MB.
 * `bytes` should measure plain columns: SQLite sizes those without reading their text.
 */
export function boundedStoredJsonSql(
  expression: string,
  as: string,
  bytes = `octet_length(${expression})`
): string {
  return `CASE WHEN ${bytes}<=${JOURNAL_READER_REPLY_BYTE_LIMIT} THEN ${expression} END AS ${as},
    ${bytes} AS ${as}_bytes`
}

/** The selected JSON text, or a refusal of the read when the stored value was too large to load. */
export function boundedStoredJson(row: Record<string, unknown>, as: string): unknown {
  const bytes = row[`${as}_bytes`]
  if (typeof bytes === 'number' && bytes > JOURNAL_READER_REPLY_BYTE_LIMIT) {
    throw new Error(
      `journal stored item (${bytes} bytes) exceeds ${JOURNAL_READER_REPLY_BYTE_LIMIT} bytes`
    )
  }
  return row[as]
}
