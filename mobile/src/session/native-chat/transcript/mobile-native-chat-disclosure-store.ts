// Store disclosures above recycled transcript rows so opened tools remain open when rows remount.

import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from 'react'
import { MobileNativeChatScrollRoots } from '../../mobile-native-chat-scroll-roots'
import type { MobileNativeChatRootPosition } from '../../mobile-native-chat-scroll-root-handle'

export type MobileNativeChatRunScroll = MobileNativeChatRootPosition

export type MobileNativeChatDisclosureStore = {
  read: (key: string) => boolean | undefined
  write: (key: string, open: boolean) => void
  // Keep scroll offsets outside React state so scrolling a run cannot rerender the transcript.
  runScroll: Map<string, MobileNativeChatRunScroll>
  roots: MobileNativeChatScrollRoots
}

export const MobileNativeChatDisclosureContext =
  createContext<MobileNativeChatDisclosureStore | null>(null)

export const MAX_DISCLOSURES = 512

type ScopedDisclosures = {
  scopeKey: string
  open: ReadonlyMap<string, boolean>
  runScroll: Map<string, MobileNativeChatRunScroll>
  roots: MobileNativeChatScrollRoots
}

function emptyDisclosures(scopeKey: string): ScopedDisclosures {
  const runScroll = new Map<string, MobileNativeChatRunScroll>()
  return {
    scopeKey,
    open: new Map(),
    runScroll,
    roots: new MobileNativeChatScrollRoots(runScroll, MAX_DISCLOSURES)
  }
}

export function useMobileNativeChatDisclosures(scopeKey: string): MobileNativeChatDisclosureStore {
  const [state, setState] = useState(() => emptyDisclosures(scopeKey))
  if (state.scopeKey !== scopeKey) {
    setState(emptyDisclosures(scopeKey))
  }
  const { open, runScroll, roots } = state
  useLayoutEffect(() => () => roots.dispose(), [roots])
  const write = useCallback(
    (key: string, next: boolean) => {
      if (!next) {
        roots.forget(key)
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
    [roots]
  )
  return useMemo(
    () => ({ read: (key: string) => open.get(key), write, runScroll, roots }),
    [open, write, runScroll, roots]
  )
}

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

const EMPTY_TURN_IDS: ReadonlySet<string> = new Set()
const MAX_EXPANDED_TURNS = 128

export function useMobileNativeChatScopedOpenKeys(
  scopeKey: string
): [ReadonlySet<string>, (key: string, base?: ReadonlySet<string>) => void] {
  const [state, setState] = useState<{ scopeKey: string; keys: ReadonlySet<string> }>(() => ({
    scopeKey,
    keys: new Set()
  }))
  const toggle = useCallback(
    (key: string, base?: ReadonlySet<string>) => {
      setState((current) => {
        const next = new Set(base ?? (current.scopeKey === scopeKey ? current.keys : []))
        if (!next.delete(key)) {
          if (next.size >= MAX_EXPANDED_TURNS) {
            const oldest = next.values().next().value
            if (oldest) {
              next.delete(oldest)
            }
          }
          next.add(key)
        }
        return { scopeKey, keys: next }
      })
    },
    [scopeKey]
  )
  return [state.scopeKey === scopeKey ? state.keys : EMPTY_TURN_IDS, toggle]
}
