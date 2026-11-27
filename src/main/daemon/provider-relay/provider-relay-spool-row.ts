import type { ProviderRelayRecord } from '../protocol/daemon-provider-relay-protocol'

/**
 * A spool file row is `<seq> <line>\n`, raw: agent lines are split on newlines so never hold one,
 * and the file is private to the daemon that wrote it. Nothing is escaped, so writing costs no scan.
 */
export function encodeSpoolRow(seq: number, line: string): string {
  return `${seq} ${line}\n`
}

/** The seq at a row's start; a row is decided once this much of it is read. */
export const SPOOL_ROW_SEQ = /^(\d{1,16}) /
export const SPOOL_ROW_PREFIX_CHARS = 32

/** A row without its newline; null for anything the spool didn't write. */
export function parseSpoolRow(row: string): ProviderRelayRecord | null {
  const seq = SPOOL_ROW_SEQ.exec(row.slice(0, SPOOL_ROW_PREFIX_CHARS))
  if (!seq) {
    return null
  }
  const value = Number(seq[1])
  return Number.isSafeInteger(value) ? { seq: value, line: row.slice(seq[0].length) } : null
}
