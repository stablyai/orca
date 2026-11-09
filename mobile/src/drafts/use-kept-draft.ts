import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction
} from 'react'
import * as z from 'zod'
import {
  durableDraftRow,
  pageDraftRowBackend,
  resetDurableDraftRowsForTests,
  type DurableDraftRow
} from './durable-draft-rows'

type Slot = {
  // Null when nothing is kept, which removes the row.
  value: unknown
  // Set by this page before the row was read: what the user did since wins over the saved copy.
  touched: boolean
  listeners: Set<() => void>
  row: DurableDraftRow
}
const slots = new Map<string, Slot>()

function slotFor(key: string, schema: z.ZodType): Slot {
  let slot = slots.get(key)
  if (!slot) {
    const created: Slot = {
      value: null,
      touched: false,
      listeners: new Set(),
      row: durableDraftRow(key, {
        backend: () => pageDraftRowBackend(key),
        snapshot: () => created.value,
        restore: (saved) => {
          const parsed = schema.safeParse(saved)
          if (created.touched || !parsed.success) {
            return
          }
          created.value = parsed.data
          created.listeners.forEach((listener) => listener())
        }
      })
    }
    slot = created
    slots.set(key, slot)
  }
  return slot
}

/** Keeps a draft for the page's life and in the device store; null drops it at once. Safe after unmount. */
export function setKeptDraft<T>(key: string, schema: z.ZodType<T>, value: T | null): void {
  const slot = slotFor(key, schema)
  slot.touched = true
  if (!Object.is(slot.value, value)) {
    slot.value = value
    slot.listeners.forEach((listener) => listener())
  }
  // The row skips a write that matches what it holds; a drop still clears a copy this page never read.
  slot.row.save(value === null ? 'immediate' : 'deferred')
}

const NO_KEY_SUBSCRIBE = () => () => {}

// Drafts are plain data, so a function is always an updater.
function isUpdater<S>(next: SetStateAction<S>): next is (current: S) => S {
  return typeof next === 'function'
}

/**
 * A draft that outlives its screen and the app being killed, shared by every mount of its key. A saved copy
 * comes back only while this page hasn't touched the draft. A null key keeps it in the component only.
 */
export function useKeptDraft<T>(
  key: string | null,
  schema: z.ZodType<T>
): [T | null, (next: SetStateAction<T | null>) => void] {
  const [local, setLocal] = useState<T | null>(null)
  const subscribe = useCallback(
    (listener: () => void) => {
      if (key === null) {
        return () => {}
      }
      const { listeners } = slotFor(key, schema)
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    [key, schema]
  )
  const kept = useSyncExternalStore(key === null ? NO_KEY_SUBSCRIBE : subscribe, () =>
    key === null ? null : slotFor(key, schema).value
  )
  useEffect(() => {
    if (key !== null) {
      void slotFor(key, schema).row.load()
    }
  }, [key, schema])
  const set = useCallback(
    (next: SetStateAction<T | null>) => {
      if (key === null) {
        setLocal(next)
        return
      }
      const current = schema.safeParse(slotFor(key, schema).value)
      const value = current.success ? current.data : null
      setKeptDraft(key, schema, isUpdater(next) ? next(value) : next)
    },
    [key, schema]
  )
  // Parsed once per stored value, so an object draft keeps its identity across renders.
  const value = useMemo(() => {
    const parsed = schema.safeParse(kept)
    return parsed.success ? parsed.data : null
  }, [kept, schema])
  return [key === null ? local : value, set]
}

const TEXT = z.string()

/** Typed text kept as a draft; an emptied field drops it. */
export function useKeptTextDraft(key: string | null): [string, Dispatch<SetStateAction<string>>] {
  const [kept, setKept] = useKeptDraft(key, TEXT)
  const setText = useCallback(
    (next: SetStateAction<string>) =>
      setKept((current) => {
        const text = typeof next === 'function' ? next(current ?? '') : next
        return text === '' ? null : text
      }),
    [setKept]
  )
  return [kept ?? '', setText]
}

export function resetKeptDraftsForTests(): void {
  slots.clear()
  resetDurableDraftRowsForTests()
}
