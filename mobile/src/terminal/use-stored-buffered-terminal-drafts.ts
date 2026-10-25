import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
  type SetStateAction
} from 'react'
import { persistMirrored } from '../storage/mirrored-storage-keys'

type Drafts = Record<string, string>
type StoredDrafts = { drafts: Drafts; surfaces: Record<string, string> }
const writes = new Map<string, Promise<void>>()

function parseStoredDrafts(raw: string | null): StoredDrafts {
  try {
    const value: unknown = JSON.parse(raw ?? '{}')
    if (typeof value !== 'object' || value === null) {
      return { drafts: {}, surfaces: {} }
    }
    const record = (field: unknown): Drafts =>
      typeof field === 'object' && field !== null
        ? Object.fromEntries(
            Object.entries(field).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string'
            )
          )
        : {}
    return {
      drafts: record('drafts' in value ? value.drafts : null),
      surfaces: record('surfaces' in value ? value.surfaces : null)
    }
  } catch {
    return { drafts: {}, surfaces: {} }
  }
}

export function useStoredBufferedTerminalDrafts(
  storageKey: string | undefined,
  surfaces: RefObject<Map<string, string>>,
  reconciled: RefObject<boolean>,
  onStorageError?: () => void,
  storageScope = 'paired'
) {
  const identity = `${storageKey ?? ''}:${encodeURIComponent(storageScope)}`
  const [state, setState] = useState<{
    key: string | undefined
    drafts: Drafts
    loaded: boolean
    edited: string[]
  }>({
    key: identity,
    drafts: {},
    loaded: !storageKey,
    edited: []
  })
  const scopePrefix = `${encodeURIComponent(storageScope)}:`
  const warned = useRef(false)
  const errorRef = useRef(onStorageError)
  const reportError = useCallback(() => {
    if (!warned.current) {
      warned.current = true
      errorRef.current?.()
    }
  }, [])
  useEffect(() => {
    errorRef.current = onStorageError
  }, [onStorageError])
  useEffect(() => {
    surfaces.current.clear()
    reconciled.current = false
    warned.current = false
  }, [identity, surfaces, reconciled])
  if (state.key !== identity) {
    setState({ key: identity, drafts: {}, loaded: !storageKey, edited: [] })
  }
  const setDrafts = useCallback((update: SetStateAction<Drafts>) => {
    setState((current) => {
      const next = typeof update === 'function' ? update(current.drafts) : update
      if (next === current.drafts) {
        return current
      }
      const changed = [...new Set([...Object.keys(current.drafts), ...Object.keys(next)])].filter(
        (handle) => current.drafts[handle] !== next[handle]
      )
      return { ...current, drafts: next, edited: [...new Set([...current.edited, ...changed])] }
    })
  }, [])

  useEffect(() => {
    if (!storageKey) {
      return
    }
    let cancelled = false
    void (writes.get(storageKey) ?? Promise.resolve())
      .then(() => AsyncStorage.getItem(storageKey))
      .then((raw) => {
        if (cancelled) {
          return
        }
        const stored = parseStoredDrafts(raw)
        const scopeDrafts = Object.fromEntries(
          Object.entries(stored.drafts)
            .filter(([handle]) => handle.startsWith(scopePrefix))
            .map(([handle, text]) => [handle.slice(scopePrefix.length), text])
        )
        const scopeSurfaces = Object.fromEntries(
          Object.entries(stored.surfaces)
            .filter(([surface]) => surface.startsWith(scopePrefix))
            .map(([surface, handle]) => [surface.slice(scopePrefix.length), handle])
        )
        const restored: Drafts = {}
        for (const [surface, handle] of Object.entries(scopeSurfaces)) {
          const target = surfaces.current.get(surface)
          if (!target && reconciled.current) {
            continue
          }
          if (!target) {
            surfaces.current.set(surface, handle)
          }
          const nextHandle = target ?? handle
          if (scopeDrafts[handle]) {
            restored[nextHandle] = scopeDrafts[handle]
          }
        }
        setState((current) => {
          const edited = new Set(current.edited)
          return current.key !== identity
            ? current
            : {
                ...current,
                loaded: true,
                drafts: {
                  ...Object.fromEntries(
                    Object.entries(restored).filter(([handle]) => !edited.has(handle))
                  ),
                  ...current.drafts
                }
              }
        })
      })
      .catch(() => {
        if (!cancelled) {
          reportError()
        }
      })
    return () => {
      cancelled = true
    }
  }, [storageKey, surfaces, reconciled, scopePrefix, reportError, identity])

  useEffect(() => {
    if (!storageKey || state.key !== identity || !state.loaded) {
      return
    }
    const drafts = Object.fromEntries(
      Object.entries(state.drafts).filter(([, text]) => text.length > 0)
    )
    const surfaceEntries = Object.fromEntries(
      [...surfaces.current].filter(([, handle]) => Object.hasOwn(drafts, handle))
    )
    const write = (writes.get(storageKey) ?? Promise.resolve()).then(async () => {
      const previousRaw = await AsyncStorage.getItem(storageKey)
      const stored = parseStoredDrafts(previousRaw)
      const otherDrafts = Object.fromEntries(
        Object.entries(stored.drafts).filter(([handle]) => !handle.startsWith(scopePrefix))
      )
      const otherSurfaces = Object.fromEntries(
        Object.entries(stored.surfaces).filter(([surface]) => !surface.startsWith(scopePrefix))
      )
      const raw = JSON.stringify({
        drafts: {
          ...otherDrafts,
          ...Object.fromEntries(
            Object.entries(drafts).map(([handle, text]) => [scopePrefix + handle, text])
          )
        },
        surfaces: {
          ...otherSurfaces,
          ...Object.fromEntries(
            Object.entries(surfaceEntries).map(([surface, handle]) => [
              scopePrefix + surface,
              handle
            ])
          )
        }
      })
      if (
        Object.keys(drafts).length === 0 &&
        Object.keys(otherDrafts).length === 0 &&
        previousRaw === null
      ) {
        return
      }
      if (raw !== previousRaw) {
        await persistMirrored(storageKey, raw)
        if ((await AsyncStorage.getItem(storageKey)) !== raw) {
          throw new Error('Command draft storage refused the write')
        }
      }
    })
    const barrier = write.catch(reportError)
    writes.set(storageKey, barrier)
    void barrier.then(() => {
      if (writes.get(storageKey) === barrier) {
        writes.delete(storageKey)
      }
    })
  }, [storageKey, state, surfaces, scopePrefix, identity, reportError])

  return [state.key === identity ? state.drafts : {}, setDrafts] as const
}
