import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { jsonBytes } from './json-string-shortening'

// Revision objects are immutable, so each row's size is measured once for every viewer and save.
const rowBytes = new WeakMap<AgentJournalRenderItem, number>()

export function sizedRowBytes(item: AgentJournalRenderItem): number {
  let bytes = rowBytes.get(item)
  if (bytes === undefined) {
    bytes = jsonBytes(item)
    rowBytes.set(item, bytes)
  }
  return bytes
}

/** The JSON size of a row list, from its rows' measured sizes, brackets and commas. */
export function sizedPageBytes(items: readonly AgentJournalRenderItem[]): number {
  let bytes = 2 + Math.max(0, items.length - 1)
  for (const item of items) {
    bytes += sizedRowBytes(item)
  }
  return bytes
}
