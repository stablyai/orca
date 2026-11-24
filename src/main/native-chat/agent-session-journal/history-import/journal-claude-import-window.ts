import { setImmediate } from 'node:timers/promises'
import type { JournalReplacementItem } from '../context-epochs/journal-epoch-replacement'
import { ClaudeImportResourceError } from './journal-claude-import-resource-error'
import type {
  ClaudeImportEntry,
  ClaudeImportFieldFragment,
  ClaudeImportHeader,
  ClaudeImportItemPart,
  ClaudeImportPage
} from './journal-claude-import-worker-protocol'

export type ClaudeImportResult = ClaudeImportHeader & { items: JournalReplacementItem[] }

type FragmentObject = Record<string, unknown>

function isFragmentObject(value: unknown): value is FragmentObject {
  return typeof value === 'object' && value !== null
}

function applyClaudeImportFieldFragment(
  root: FragmentObject,
  entry: ClaudeImportFieldFragment
): void {
  const path = entry.path
  let target = root
  for (let index = 0; index < path.length - 1; index++) {
    const key = path[index]!
    const child = Object.hasOwn(target, key) ? target[key] : undefined
    if (!isFragmentObject(child)) {
      throw new ClaudeImportResourceError('Unexpected Claude import fragment path.')
    }
    target = child
  }
  const key = path.at(-1)!
  let value = entry.kind === 'wide-field' ? entry.value : entry.text
  if (entry.kind === 'wide-text') {
    const previous = Object.hasOwn(target, key) ? target[key] : undefined
    if (typeof previous !== 'string') {
      throw new ClaudeImportResourceError('Unexpected Claude import text fragment.')
    }
    value = `${previous}${entry.text}`
  }
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  })
}

function decodeImportEntries(): (entry: ClaudeImportEntry) => ClaudeImportItemPart | undefined {
  let wide: FragmentObject | undefined
  return (entry) => {
    switch (entry.kind) {
      case 'wide-start':
        wide = {}
        return
      case 'wide-field':
      case 'wide-text': {
        applyClaudeImportFieldFragment(wide!, entry)
        return
      }
      case 'wide-end': {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The worker fragments a ClaudeImportItemPart property by property.
        const completed = wide as ClaudeImportItemPart
        wide = undefined
        return completed
      }
      case 'item':
      case 'start':
      case 'block':
      case 'end':
        return entry
    }
  }
}

export async function collectClaudeImportWindow(
  header: ClaudeImportHeader,
  pull: () => Promise<ClaudeImportPage>,
  check: () => void
): Promise<ClaudeImportResult> {
  const items: JournalReplacementItem[] = []
  const decodeEntry = decodeImportEntries()
  let partial: Extract<ClaudeImportItemPart, { kind: 'start' }> | undefined
  while (true) {
    const page = await pull()
    check()
    for (const fragment of page.entries) {
      const entry = decodeEntry(fragment)
      if (!entry) {
        continue
      }
      switch (entry.kind) {
        case 'item':
          items.push(entry.item)
          break
        case 'start':
          partial = entry
          break
        case 'block':
          partial!.item.body.blocks.push(entry.block)
          break
        case 'end':
          items.push(partial!.item)
          partial = undefined
          break
      }
    }
    if (page.done) {
      return { ...header, items: items.toReversed() }
    }
    await setImmediate()
  }
}
