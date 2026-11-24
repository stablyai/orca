import { serialize } from 'node:v8'
import { ClaudeImportResourceError } from './journal-claude-import-resource-error'
import {
  CLAUDE_IMPORT_PAGE_BYTES,
  CLAUDE_IMPORT_PAGE_ENTRIES,
  type ClaudeImportEntry,
  type ClaudeImportFieldFragment,
  type ClaudeImportItemPart,
  type ClaudeImportPage
} from './journal-claude-import-worker-protocol'
import type { JournalReplacementItem } from '../context-epochs/journal-epoch-replacement'

const PAGE_FRAMING_BYTES = 128
// Allow a varint array index and V8 alignment padding per entry.
const ENTRY_FRAMING_BYTES = 8
const CLAUDE_IMPORT_ENTRIES_BYTES = CLAUDE_IMPORT_PAGE_BYTES - PAGE_FRAMING_BYTES

function claudeImportEntryBytes(entry: unknown): number {
  return serialize(entry).byteLength + ENTRY_FRAMING_BYTES
}

function* itemEntries(items: JournalReplacementItem[]) {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!
    const entry: ClaudeImportEntry = { kind: 'item', item }
    const size = claudeImportEntryBytes(entry)
    if (size <= CLAUDE_IMPORT_ENTRIES_BYTES) {
      yield { entry, size }
      continue
    }
    if (item.body.kind !== 'message') {
      yield* wideEntry(entry)
      continue
    }
    yield* fragment({ kind: 'start', item: { ...item, body: { ...item.body, blocks: [] } } })
    for (const block of item.body.blocks) {
      yield* fragment({ kind: 'block', block })
    }
    yield* fragment({ kind: 'end' })
  }
}

function* fragment(entry: ClaudeImportItemPart) {
  const size = claudeImportEntryBytes(entry)
  if (size <= CLAUDE_IMPORT_ENTRIES_BYTES) {
    yield { entry, size }
  } else {
    yield* wideEntry(entry)
  }
}

function measured<Entry extends ClaudeImportEntry>(entry: Entry) {
  const size = claudeImportEntryBytes(entry)
  if (size > CLAUDE_IMPORT_ENTRIES_BYTES) {
    throw new ClaudeImportResourceError('A Claude import fragment path exceeds the page limit.')
  }
  return { entry, size }
}

// Some blocks carry uncapped metadata such as edit hunks. Stream their large fields too.
function* wideEntry(entry: ClaudeImportItemPart) {
  yield measured({ kind: 'wide-start' })
  for (const [key, value] of Object.entries(entry)) {
    yield* wideField([key], value)
  }
  yield measured({ kind: 'wide-end' })
}

type MeasuredField = { entry: ClaudeImportFieldFragment; size: number }

function* wideField(path: string[], value: unknown): Generator<MeasuredField> {
  const entry: ClaudeImportFieldFragment = { kind: 'wide-field', path, value }
  const size =
    typeof value === 'string' && value.length > CLAUDE_IMPORT_ENTRIES_BYTES
      ? Infinity
      : claudeImportEntryBytes(entry)
  if (size <= CLAUDE_IMPORT_ENTRIES_BYTES) {
    yield { entry, size }
  } else if (typeof value === 'string') {
    yield measured({ ...entry, value: '' })
    // Allow for UTF-16 code units and for framing when sharing a page.
    const chars = CLAUDE_IMPORT_PAGE_BYTES / 4 - 256
    for (let offset = 0; offset < value.length; offset += chars) {
      yield measured({ kind: 'wide-text', path, text: value.slice(offset, offset + chars) })
    }
  } else if (value && typeof value === 'object') {
    yield measured({ ...entry, value: Array.isArray(value) ? [] : {} })
    for (const [key, child] of Object.entries(value)) {
      yield* wideField([...path, key], child)
    }
  } else {
    throw new ClaudeImportResourceError('A Claude import fragment path exceeds the page limit.')
  }
}

export function* claudeImportPages(items: JournalReplacementItem[]): Generator<ClaudeImportPage> {
  let entries: ClaudeImportEntry[] = []
  let bytes = 0
  for (const { entry, size } of itemEntries(items)) {
    if (
      entries.length === CLAUDE_IMPORT_PAGE_ENTRIES ||
      bytes + size > CLAUDE_IMPORT_ENTRIES_BYTES
    ) {
      yield { kind: 'page', entries, done: false }
      entries = []
      bytes = 0
    }
    entries.push(entry)
    bytes += size
  }
  yield { kind: 'page', entries, done: true }
}
