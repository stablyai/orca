import { useCallback, useSyncExternalStore, type SetStateAction } from 'react'
import * as z from 'zod'
import {
  durableDraftRow,
  pageDraftRowBackend,
  resetDurableDraftRowsForTests,
  type DurableDraftRow
} from './durable-draft-rows'

// A row's typed text fields; an empty field is left out, and a row with none is removed.
type DraftFields = Readonly<Record<string, string>>

const savedFieldsSchema = z.record(z.string(), z.string())

type Slot = {
  fields: DraftFields
  // Fields set on this page, cleared ones included; a read that lands later never overwrites them.
  touched: Set<string>
  listeners: Set<() => void>
  row: DurableDraftRow
}

// The page's copy of each row, so a form that closes and reopens shows its text without a read.
const slots = new Map<string, Slot>()

function notify(slot: Slot): void {
  for (const listener of slot.listeners) {
    listener()
  }
}

function slotFor(key: string): Slot {
  const existing = slots.get(key)
  if (existing) {
    return existing
  }
  const slot: Slot = {
    fields: {},
    touched: new Set(),
    listeners: new Set(),
    row: durableDraftRow(key, {
      backend: () => pageDraftRowBackend(key),
      snapshot: () => (Object.keys(slot.fields).length > 0 ? slot.fields : null),
      restore: (saved) => {
        const parsed = savedFieldsSchema.safeParse(saved)
        if (!parsed.success) {
          return
        }
        // Text typed or cleared before the read landed wins over the saved copy.
        const restored = Object.entries(parsed.data).filter(
          ([field, text]) => text && !slot.touched.has(field)
        )
        if (restored.length === 0) {
          return
        }
        slot.fields = { ...Object.fromEntries(restored), ...slot.fields }
        notify(slot)
      }
    })
  }
  slots.set(key, slot)
  return slot
}

/** Sets one field of a row, wherever it is shown; a send that settles after its form closed clears its own row. */
export function updateDurableDraftField(
  key: string,
  field: string,
  update: SetStateAction<string>
): void {
  const slot = slotFor(key)
  const current = slot.fields[field] ?? ''
  const next = typeof update === 'function' ? update(current) : update
  // Even an unchanged value is the user's choice: a read still pending must not overwrite it.
  slot.touched.add(field)
  if (next === current) {
    return
  }
  const rest = Object.fromEntries(Object.entries(slot.fields).filter(([name]) => name !== field))
  slot.fields = next ? { ...rest, [field]: next } : rest
  notify(slot)
  // An emptied row is written at once, so sent text can't come back.
  slot.row.save(Object.keys(slot.fields).length > 0 ? 'deferred' : 'immediate')
}

/**
 * One typed field kept in a draft row: it survives the form closing and the page being killed, and
 * comes back only into a field still empty. A null key (nothing to type into) holds nothing.
 */
export function useDurableDraftField(
  key: string | null,
  field: string
): readonly [string, (update: SetStateAction<string>) => void] {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!key) {
        return () => {}
      }
      const slot = slotFor(key)
      slot.listeners.add(onChange)
      // Read once per page; a read the store dropped is retried by the next form that opens the row.
      void slot.row.load()
      return () => {
        slot.listeners.delete(onChange)
      }
    },
    [key]
  )
  const read = () => (key ? (slots.get(key)?.fields[field] ?? '') : '')
  const value = useSyncExternalStore(subscribe, read, read)
  // Bound to this key, so a send that settles after the user moved on clears the row it came from.
  const setValue = useCallback(
    (update: SetStateAction<string>) => {
      if (key) {
        updateDurableDraftField(key, field, update)
      }
    },
    [field, key]
  )
  return [value, setValue] as const
}

export function resetDurableDraftFieldsForTests(): void {
  slots.clear()
  resetDurableDraftRowsForTests()
}
