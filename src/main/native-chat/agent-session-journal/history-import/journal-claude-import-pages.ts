import { serialize } from 'node:v8'
import { ClaudeImportResourceError } from './journal-claude-import-resource-error'
import {
  CLAUDE_IMPORT_PAGE_BYTES,
  CLAUDE_IMPORT_PAGE_ENTRIES,
  type ClaudeImportEntry,
  type ClaudeImportItemPart,
  type ClaudeImportPage
} from './journal-claude-import-worker-protocol'
import type { importClaudeTranscript } from './journal-claude-import'

const PAGE_FRAMING_BYTES = 128
// Allow a varint array index and V8 alignment padding per entry.
const ENTRY_FRAMING_BYTES = 8
const ENTRIES_BYTES = CLAUDE_IMPORT_PAGE_BYTES - PAGE_FRAMING_BYTES

type Window = Pick<Awaited<ReturnType<typeof importClaudeTranscript>>, 'items' | 'savedKeys'>

function wireBytes(entry: ClaudeImportEntry): number {
  return serialize(entry).byteLength + ENTRY_FRAMING_BYTES
}

function* itemEntries({
  items,
  savedKeys
}: Window): Generator<{ entry: ClaudeImportEntry; size: number }> {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!
    const keys = savedKeys?.[index] ?? []
    const bytes = Buffer.byteLength(JSON.stringify(item))
    const entry: ClaudeImportEntry = { kind: 'item', item, keys, bytes }
    const size = wireBytes(entry)
    if (size <= ENTRIES_BYTES) {
      yield { entry, size }
      continue
    }
    if (item.body.kind !== 'message') {
      yield* wideEntry(entry)
      continue
    }
    yield* fragment({ kind: 'start', item: { ...item, body: { ...item.body, blocks: [] } }, bytes })
    for (const key of keys) {
      yield* fragment({ kind: 'key', key })
    }
    for (const block of item.body.blocks) {
      yield* fragment({ kind: 'block', block })
    }
    yield* fragment({ kind: 'end' })
  }
}

function* fragment(entry: ClaudeImportItemPart) {
  const size = wireBytes(entry)
  if (size <= ENTRIES_BYTES) {
    yield { entry, size }
  } else {
    yield* wideEntry(entry)
  }
}

function measured(entry: ClaudeImportEntry) {
  const size = wireBytes(entry)
  if (size > ENTRIES_BYTES) {
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

function* wideField(
  path: string[],
  value: unknown
): Generator<{ entry: ClaudeImportEntry; size: number }> {
  const entry: ClaudeImportEntry = { kind: 'wide-field', path, value }
  const size = wireBytes(entry)
  if (size <= ENTRIES_BYTES) {
    yield { entry, size }
  } else if (typeof value === 'string') {
    yield measured({ ...entry, value: '' })
    const chars = CLAUDE_IMPORT_PAGE_BYTES / 4
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

export function* claudeImportPages(window: Window): Generator<ClaudeImportPage> {
  let entries: ClaudeImportEntry[] = []
  let bytes = 0
  for (const { entry, size } of itemEntries(window)) {
    if (entries.length === CLAUDE_IMPORT_PAGE_ENTRIES || bytes + size > ENTRIES_BYTES) {
      yield { kind: 'page', entries, done: false }
      entries = []
      bytes = 0
    }
    entries.push(entry)
    bytes += size
  }
  yield { kind: 'page', entries, done: true }
}
