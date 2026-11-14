import {
  createTomlLineScanState,
  isTomlStructuralLine,
  updateTomlLineScanState,
  type TomlLineScanState
} from '../../configuration/toml/config-toml-line-scan'
import { normalizeCodexHookTrustLookupKey } from '../identity/codex-trust-identity'
import {
  findNextTomlTableHeader,
  parseHookStateTomlHeaderKey
} from '../../configuration/toml/config-toml-syntax'

export type HookTrustBlockRange = {
  start: number
  headerLineEnd: number
  contentStart: number
  end: number
}

export function findHookTrustBlockRanges(
  content: string,
  normalizedKeys: ReadonlySet<string>
): HookTrustBlockRange[] {
  const ranges: HookTrustBlockRange[] = []
  if (normalizedKeys.size === 0) {
    return ranges
  }
  let cursor = 0
  let scanState = createTomlLineScanState()
  while (cursor < content.length) {
    const newlineIndex = content.indexOf('\n', cursor)
    const lineEnd = newlineIndex === -1 ? content.length : newlineIndex
    const rawLine = content.slice(cursor, lineEnd)
    const lineWithoutCr = rawLine.replace(/\r$/, '')
    const line =
      cursor === 0 && lineWithoutCr.charCodeAt(0) === 0xfeff
        ? lineWithoutCr.slice(1)
        : lineWithoutCr
    const nextCursor = newlineIndex === -1 ? content.length : newlineIndex + 1
    const headerKey = isTomlStructuralLine(scanState) ? parseHookStateTomlHeaderKey(line) : null
    if (headerKey !== null && normalizedKeys.has(normalizeCodexHookTrustLookupKey(headerKey))) {
      const headerLineEnd = rawLine.endsWith('\r') ? lineEnd - 1 : lineEnd
      const nextHeaderOffset = findNextTomlTableHeader(content.slice(nextCursor))
      const blockEnd = nextHeaderOffset === -1 ? content.length : nextCursor + nextHeaderOffset
      ranges.push({ start: cursor, headerLineEnd, contentStart: nextCursor, end: blockEnd })
      cursor = Math.max(blockEnd, nextCursor)
      continue
    }
    scanState = updateTomlLineScanState(scanState, line)
    cursor = nextCursor
  }
  return ranges
}

// A slot runs from a visible table header to the next one, as findHookTrustBlockRanges measures.
type HookTrustSlot = {
  key: string | null
  chunks: string[]
  prev: HookTrustSlot | null
  next: HookTrustSlot | null
}

export type HookTrustDocument = {
  head: HookTrustSlot
  tail: HookTrustSlot
  tailState: TomlLineScanState
  slotsByKey: Map<string, HookTrustSlot[]>
}

export function scanHookTrustDocument(content: string): HookTrustDocument {
  const head: HookTrustSlot = { key: null, chunks: [], prev: null, next: null }
  const document: HookTrustDocument = {
    head,
    tail: head,
    tailState: createTomlLineScanState(),
    slotsByKey: new Map()
  }
  appendHookTrustText(document, content, true)
  return document
}

export function joinHookTrustDocument(document: HookTrustDocument): string {
  const chunks: string[] = []
  for (let slot: HookTrustSlot | null = document.head; slot; slot = slot.next) {
    chunks.push(...slot.chunks)
  }
  return chunks.join('')
}

export function readHookTrustDocumentEnding(document: HookTrustDocument): string {
  let ending = ''
  for (
    let slot: HookTrustSlot | null = document.tail;
    slot && ending.length < 2;
    slot = slot.prev
  ) {
    for (let index = slot.chunks.length - 1; index >= 0 && ending.length < 2; index -= 1) {
      ending = slot.chunks[index].slice(ending.length - 2) + ending
    }
  }
  return ending
}

// Text under an open multiline value stays in the slot owning EOF until a header becomes visible.
export function appendHookTrustText(
  document: HookTrustDocument,
  text: string,
  atDocumentStart = false
): void {
  const scanned = scanHookTrustText(text, document.tailState, atDocumentStart)
  if (scanned.lead) {
    document.tail.chunks.push(scanned.lead)
  }
  document.tail = linkHookTrustSlots(document.tail, scanned.slots, null)
  document.tailState = scanned.state
  for (const slot of scanned.slots) {
    indexHookTrustSlot(document, slot)
  }
}

/**
 * Replace the first slot and drop the rest, like the sequential string edit. Returns false when
 * the generated text would change what later existing text means, which only full rescans model.
 */
export function replaceHookTrustSlots(
  document: HookTrustDocument,
  slots: readonly HookTrustSlot[],
  text: string,
  normalizedKeys: ReadonlySet<string>
): boolean {
  const [first, ...duplicates] = slots
  const scanned = scanHookTrustText(text, createTomlLineScanState())
  if (
    !first ||
    (first.next !== null && !isTomlStructuralLine(scanned.state)) ||
    scanned.slots.some(({ key }) => key !== null && !normalizedKeys.has(key))
  ) {
    return false
  }
  const prev = first.prev!
  if (scanned.lead) {
    prev.chunks.push(scanned.lead)
  }
  const last = linkHookTrustSlots(prev, scanned.slots, first.next)
  if (document.tail === first) {
    document.tail = last
    document.tailState = scanned.state
  }
  for (const duplicate of duplicates) {
    duplicate.prev!.next = duplicate.next
    if (duplicate.next) {
      duplicate.next.prev = duplicate.prev
    } else {
      // A slot starts at a visible header, so removing the EOF owner leaves structural EOF.
      document.tail = duplicate.prev!
      document.tailState = createTomlLineScanState()
    }
  }
  for (const key of normalizedKeys) {
    document.slotsByKey.delete(key)
  }
  for (const slot of scanned.slots) {
    indexHookTrustSlot(document, slot)
  }
  return true
}

function linkHookTrustSlots(
  prev: HookTrustSlot,
  slots: readonly HookTrustSlot[],
  next: HookTrustSlot | null
): HookTrustSlot {
  let last = prev
  for (const slot of slots) {
    slot.prev = last
    last.next = slot
    last = slot
  }
  last.next = next
  if (next) {
    next.prev = last
  }
  return last
}

function indexHookTrustSlot(document: HookTrustDocument, slot: HookTrustSlot): void {
  if (slot.key !== null) {
    const slots = document.slotsByKey.get(slot.key)
    if (slots) {
      slots.push(slot)
    } else {
      document.slotsByKey.set(slot.key, [slot])
    }
  }
}

function scanHookTrustText(
  text: string,
  initialState: TomlLineScanState,
  atDocumentStart = false
): { lead: string; slots: HookTrustSlot[]; state: TomlLineScanState } {
  const slots: HookTrustSlot[] = []
  let lead = ''
  let slotStart = 0
  let state = initialState
  let cursor = 0
  const closeSlot = (end: number): void => {
    const slot = slots.at(-1)
    if (slot) {
      slot.chunks.push(text.slice(slotStart, end))
    } else {
      lead = text.slice(0, end)
    }
  }
  while (cursor < text.length) {
    const newlineIndex = text.indexOf('\n', cursor)
    const lineEnd = newlineIndex === -1 ? text.length : newlineIndex
    const lineWithoutCr = text.slice(cursor, lineEnd).replace(/\r$/, '')
    const line =
      atDocumentStart && cursor === 0 && lineWithoutCr.charCodeAt(0) === 0xfeff
        ? lineWithoutCr.slice(1)
        : lineWithoutCr
    if (isTomlStructuralLine(state)) {
      const headerKey = parseHookStateTomlHeaderKey(line)
      if (headerKey !== null || findNextTomlTableHeader(line) === 0) {
        const key = headerKey === null ? null : normalizeCodexHookTrustLookupKey(headerKey)
        closeSlot(cursor)
        slotStart = cursor
        slots.push({ key, chunks: [], prev: null, next: null })
      }
    }
    state = updateTomlLineScanState(state, line)
    cursor = newlineIndex === -1 ? text.length : newlineIndex + 1
  }
  closeSlot(text.length)
  return { lead, slots, state }
}

export function findAllHookTrustBlocks(content: string): (HookTrustBlockRange & { key: string })[] {
  const blocks: (HookTrustBlockRange & { key: string })[] = []
  let cursor = 0
  let scanState = createTomlLineScanState()
  while (cursor < content.length) {
    const newlineIndex = content.indexOf('\n', cursor)
    const lineEnd = newlineIndex === -1 ? content.length : newlineIndex
    const rawLine = content.slice(cursor, lineEnd)
    const lineWithoutCr = rawLine.replace(/\r$/, '')
    const line =
      cursor === 0 && lineWithoutCr.charCodeAt(0) === 0xfeff
        ? lineWithoutCr.slice(1)
        : lineWithoutCr
    const nextCursor = newlineIndex === -1 ? content.length : newlineIndex + 1
    const key = isTomlStructuralLine(scanState) ? parseHookStateTomlHeaderKey(line) : null
    if (key !== null) {
      const nextHeaderOffset = findNextTomlTableHeader(content.slice(nextCursor))
      const blockEnd = nextHeaderOffset === -1 ? content.length : nextCursor + nextHeaderOffset
      blocks.push({
        key,
        start: cursor,
        headerLineEnd: rawLine.endsWith('\r') ? lineEnd - 1 : lineEnd,
        contentStart: nextCursor,
        end: blockEnd
      })
      cursor = nextCursor
      continue
    }
    scanState = updateTomlLineScanState(scanState, line)
    cursor = nextCursor
  }
  return blocks
}
