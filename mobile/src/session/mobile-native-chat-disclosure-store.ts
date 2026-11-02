// Desktop parity: `native-chat-disclosure-store`. Where a transcript row's open/closed
// disclosures live when the row itself may be unmounted: a run or line the reader opened
// stays open after the list recycles its row, on reload, and across the Tools toggle.

import { createContext, useCallback, useContext, useMemo, useState } from 'react'

/** Where the reader left an opened run's own scroll box. */
export type MobileNativeChatRunScroll = { top: number; followsEnd: boolean }

export type MobileNativeChatDisclosureStore = {
  read: (key: string) => boolean | undefined
  write: (key: string, open: boolean) => void
  /** By the run's disclosure key, and forgotten when that run closes. A plain map, not state:
   *  scrolling a run must not re-render the transcript. */
  runScroll: Map<string, MobileNativeChatRunScroll>
}

export const MobileNativeChatDisclosureContext =
  createContext<MobileNativeChatDisclosureStore | null>(null)

/** Bounded, so a chat that ran for a day does not carry every disclosure it ever opened. */
export const MAX_DISCLOSURES = 512

type ScopedDisclosures = {
  scopeKey: string
  open: ReadonlyMap<string, boolean>
  runScroll: Map<string, MobileNativeChatRunScroll>
}

function emptyDisclosures(scopeKey: string): ScopedDisclosures {
  return { scopeKey, open: new Map(), runScroll: new Map() }
}

/** One store per chat: another chat's choices never leak in. */
export function useMobileNativeChatDisclosures(scopeKey: string): MobileNativeChatDisclosureStore {
  const [state, setState] = useState(() => emptyDisclosures(scopeKey))
  if (state.scopeKey !== scopeKey) {
    setState(emptyDisclosures(scopeKey))
  }
  const { open, runScroll } = state
  const write = useCallback(
    (key: string, next: boolean) => {
      // Forgotten with the run that closed, as desktop does.
      if (!next) {
        runScroll.delete(key)
      }
      setState((current) => {
        if (current.open.get(key) === next) {
          return current
        }
        const updated = new Map(current.open)
        updated.delete(key)
        updated.set(key, next)
        if (updated.size > MAX_DISCLOSURES) {
          const oldest = updated.keys().next().value
          if (oldest !== undefined) {
            updated.delete(oldest)
          }
        }
        return { ...current, open: updated }
      })
    },
    [runScroll]
  )
  return useMemo(
    () => ({ read: (key: string) => open.get(key), write, runScroll }),
    [open, write, runScroll]
  )
}

/** A disclosure remembered under `key` while the transcript provides a store; local otherwise. */
export function useMobileNativeChatDisclosure(
  key: string | undefined,
  initialOpen: boolean
): [boolean, (next: boolean) => void] {
  const store = useContext(MobileNativeChatDisclosureContext)
  const [local, setLocal] = useState({ key, initialOpen, open: initialOpen })
  const localOpen =
    local.key === key && local.initialOpen === initialOpen ? local.open : initialOpen
  const open = key !== undefined && store ? (store.read(key) ?? localOpen) : localOpen
  const write = store?.write
  const setOpen = useCallback(
    (next: boolean) => {
      setLocal({ key, initialOpen, open: next })
      if (key !== undefined && write) {
        write(key, next)
      }
    },
    [initialOpen, key, write]
  )
  return [open, setOpen]
}
