import { setImmediate } from 'node:timers/promises'
import { waitForPromiseWithSignal } from '../../../../shared/concurrency/abort-signal-reason'
import { ClaudeImportResourceError } from './journal-claude-import-resource-error'
import type {
  ClaudeImportEntry,
  ClaudeImportFieldFragment,
  ClaudeImportHeader,
  ClaudeImportItem,
  ClaudeImportItemPart,
  ClaudeImportPage
} from './journal-claude-import-worker-protocol'

export type ClaudeImportResult = ClaudeImportHeader & {
  items: ClaudeImportItem['item'][]
  retainedBytes: number
}

export type ClaudeImportRestore = {
  budget: (header: ClaudeImportHeader) => number
  page: (items: ClaudeImportItem[], remainingBytes: number, check: () => void) => Promise<void>
}

type FragmentObject = Record<string, unknown>

function isFragmentObject(value: unknown): value is FragmentObject {
  return typeof value === 'object' && value !== null
}

export function applyClaudeImportFieldFragment(
  root: FragmentObject,
  entry: ClaudeImportFieldFragment
): void {
  const path = entry.path
  let target = root
  for (let index = 0; index < path.length - 1; index++) {
    const child = target[path[index]!]
    if (!isFragmentObject(child)) {
      throw new ClaudeImportResourceError('Unexpected Claude import fragment path.')
    }
    target = child
  }
  const key = path.at(-1)!
  let value = entry.kind === 'wide-field' ? entry.value : entry.text
  if (entry.kind === 'wide-text') {
    const previous = target[key]
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
      case 'key':
      case 'block':
      case 'end':
        return entry
    }
  }
}

export async function collectClaudeImportWindow(
  header: ClaudeImportHeader,
  pull: () => Promise<ClaudeImportPage>,
  check: () => void,
  signal: AbortSignal,
  restore: ClaudeImportRestore | undefined
): Promise<ClaudeImportResult> {
  const items: ClaudeImportResult['items'] = []
  const budget = restore?.budget(header) ?? Infinity
  let retainedBytes = 2
  const decodeEntry = decodeImportEntries()
  let partial: Extract<ClaudeImportItemPart, { kind: 'start' }> | undefined
  let keys: string[] = []
  const finish = () => ({ ...header, items: items.toReversed(), retainedBytes })
  while (true) {
    const page = await pull()
    check()
    const completed: ClaudeImportItem[] = []
    for (const fragment of page.entries) {
      const entry = decodeEntry(fragment)
      if (!entry) {
        continue
      }
      switch (entry.kind) {
        case 'item':
          completed.push(entry)
          break
        case 'start':
          partial = entry
          keys = []
          break
        case 'key':
          keys.push(entry.key)
          break
        case 'block':
          partial!.item.body.blocks.push(entry.block)
          break
        case 'end':
          completed.push({ item: partial!.item, bytes: partial!.bytes, keys })
          partial = undefined
          break
      }
    }
    if (restore && completed.length) {
      await waitForPromiseWithSignal(restore.page(completed, budget - retainedBytes, check), signal)
    }
    check()
    for (const entry of completed) {
      if (retainedBytes + entry.bytes + 1 > budget) {
        return finish()
      }
      retainedBytes += entry.bytes + 1
      items.push(entry.item)
    }
    if (page.done) {
      return finish()
    }
    await setImmediate()
  }
}
