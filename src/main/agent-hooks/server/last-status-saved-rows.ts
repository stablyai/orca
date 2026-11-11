import type { KeyedJsonRow } from '../../sqlite/row-cache/keyed-json-row-cache'
import { parseKeyedJsonRows } from '../../sqlite/row-cache/keyed-json-row-cache'
import { LAST_STATUS_FILE_VERSION } from './server-constants'
import type { LastStatusFile } from './server-types'

type RowKind = 'entry' | 'commitment' | 'exits'

// Follows LAST_STATUS_FILE_VERSION (a mismatched cache rebuilds empty, as the file did); the
// low digits version the row layout.
export const LAST_STATUS_SCHEMA_VERSION = LAST_STATUS_FILE_VERSION * 100 + 2

const rowKey = (kind: RowKind, key: string): string => `${kind}\u0000${key}`

/** One row per pane entry and per authority commitment, plus the exit list. */
export function rowsOf(file: LastStatusFile): KeyedJsonRow[] {
  const rows: KeyedJsonRow[] = []
  for (const [key, value] of Object.entries(file.entries)) {
    rows.push({ key: rowKey('entry', key), json: JSON.stringify(value) })
  }
  for (const [key, value] of Object.entries(file.authorityCommitments ?? {})) {
    rows.push({ key: rowKey('commitment', key), json: JSON.stringify(value) })
  }
  if (file.agentExits && file.agentExits.length > 0) {
    rows.push({ key: rowKey('exits', ''), json: JSON.stringify(file.agentExits) })
  }
  return rows
}

/** The last-status document the rows hold; an unreadable row is dropped (a save deletes it). */
export function assemble(rows: readonly KeyedJsonRow[]): Required<LastStatusFile> {
  const file: Required<LastStatusFile> = {
    version: LAST_STATUS_FILE_VERSION,
    entries: {},
    authorityCommitments: {},
    agentExits: []
  }
  for (const { key: id, value } of parseKeyedJsonRows(rows)) {
    const separator = id.indexOf('\u0000')
    const kind = id.slice(0, separator)
    const key = id.slice(separator + 1)
    if (kind === 'entry') {
      Object.assign(file.entries, { [key]: value })
    } else if (kind === 'commitment') {
      Object.assign(file.authorityCommitments, { [key]: value })
    } else if (kind === 'exits' && Array.isArray(value)) {
      file.agentExits = value
    }
  }
  return file
}
