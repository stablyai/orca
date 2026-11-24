export type BrowserPasswordCsvRow = {
  url: string
  username: string
  password: string
  note: string
  name: string
}

export type BrowserPasswordCsvParseError = 'too-large' | 'too-many-rows' | 'missing-columns'

export type BrowserPasswordCsvParseResult = {
  rows: BrowserPasswordCsvRow[]
  /** Rows over a field-length limit. URL and password validity is judged by the store on import. */
  invalid: number
  error?: BrowserPasswordCsvParseError
}

export const BROWSER_PASSWORD_CSV_MAX_BYTES = 1024 * 1024
export const BROWSER_PASSWORD_CSV_MAX_ROWS = 3000
const MAX_URL_LENGTH = 2048
const MAX_FIELD_LENGTH = 1000

type CsvColumn = keyof BrowserPasswordCsvRow

// Covers Chrome, Edge, Firefox, Safari, 1Password, Bitwarden, LastPass, Dashlane and Proton Pass exports.
const HEADER_ALIASES: Record<CsvColumn, readonly string[]> = {
  url: ['url', 'website', 'origin', 'hostname', 'login_uri', 'login url'],
  username: ['username', 'user', 'login', 'account', 'login_username', 'email'],
  password: ['password', 'login_password'],
  note: ['note', 'notes', 'comment', 'comments', 'extra'],
  name: ['name', 'title']
}

const COLUMNS: readonly CsvColumn[] = ['url', 'username', 'password', 'note', 'name']

/** RFC 4180 records: quoted fields, doubled quotes, embedded newlines, CRLF or LF. */
function parseCsvRecords(text: string): string[][] {
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  while (i < text.length) {
    const char = text[i]
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
      } else {
        field += char
      }
      i += 1
      continue
    }
    if (char === '"' && field.length === 0) {
      quoted = true
    } else if (char === ',') {
      record.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      record.push(field)
      records.push(record)
      record = []
      field = ''
      if (char === '\r' && text[i + 1] === '\n') {
        i += 1
      }
    } else {
      field += char
    }
    i += 1
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field)
    records.push(record)
  }
  // A blank line parses as one empty field; it is not a row.
  return records.filter((r) => r.length > 1 || r[0] !== '')
}

function resolveColumnIndexes(header: string[]): Partial<Record<CsvColumn, number>> {
  const normalized = header.map((h) => h.trim().toLowerCase())
  const indexes: Partial<Record<CsvColumn, number>> = {}
  for (const column of COLUMNS) {
    // Alias order is priority: Proton Pass has both `email` and a later `username` column.
    for (const alias of HEADER_ALIASES[column]) {
      const index = normalized.indexOf(alias)
      if (index !== -1) {
        indexes[column] = index
        break
      }
    }
  }
  return indexes
}

function exceedsLimits(row: BrowserPasswordCsvRow): boolean {
  return (
    row.url.length > MAX_URL_LENGTH ||
    row.username.length > MAX_FIELD_LENGTH ||
    row.password.length > MAX_FIELD_LENGTH ||
    row.note.length > MAX_FIELD_LENGTH
  )
}

export function parseBrowserPasswordCsv(text: string): BrowserPasswordCsvParseResult {
  if (Buffer.byteLength(text, 'utf8') > BROWSER_PASSWORD_CSV_MAX_BYTES) {
    return { rows: [], invalid: 0, error: 'too-large' }
  }
  const records = parseCsvRecords(text.startsWith('﻿') ? text.slice(1) : text)
  const [header, ...dataRecords] = records
  const indexes = resolveColumnIndexes(header ?? [])
  if (
    indexes.url === undefined ||
    indexes.username === undefined ||
    indexes.password === undefined
  ) {
    return { rows: [], invalid: 0, error: 'missing-columns' }
  }
  if (dataRecords.length > BROWSER_PASSWORD_CSV_MAX_ROWS) {
    return { rows: [], invalid: 0, error: 'too-many-rows' }
  }
  const cell = (record: string[], column: CsvColumn): string => {
    const index = indexes[column]
    return index === undefined ? '' : (record[index] ?? '')
  }
  const rows: BrowserPasswordCsvRow[] = []
  let invalid = 0
  for (const record of dataRecords) {
    const row: BrowserPasswordCsvRow = {
      url: cell(record, 'url').trim(),
      username: cell(record, 'username'),
      password: cell(record, 'password'),
      note: cell(record, 'note'),
      name: cell(record, 'name')
    }
    if (exceedsLimits(row)) {
      invalid += 1
    } else {
      rows.push(row)
    }
  }
  return { rows, invalid }
}
