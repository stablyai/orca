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
type StoredDrafts = { drafts: Drafts; unconfirmed: Drafts; surfaces: Record<string, string> }
type State = {
  identity: string
  drafts: Drafts
  unconfirmed: Drafts
  loaded: boolean
  edited: Set<string>
  unconfirmedEdited: Set<string>
}
const writes = new Map<string, Promise<void>>()

function parseStoredDrafts(raw: string | null): StoredDrafts {
  try {
    const value: unknown = JSON.parse(raw ?? '{}')
    const record = (field: unknown): Drafts =>
      typeof field === 'object' && field !== null
        ? Object.fromEntries(
            Object.entries(field).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string'
            )
          )
        : {}
    return typeof value === 'object' && value !== null
      ? {
          drafts: record('drafts' in value ? value.drafts : null),
          unconfirmed: record('unconfirmed' in value ? value.unconfirmed : null),
          surfaces: record('surfaces' in value ? value.surfaces : null)
        }
      : { drafts: {}, unconfirmed: {}, surfaces: {} }
  } catch {
    return { drafts: {}, unconfirmed: {}, surfaces: {} }
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
  const scopePrefix = `${encodeURIComponent(storageScope)}:`
  const empty = (): State => ({
    identity,
    drafts: {},
    unconfirmed: {},
    loaded: !storageKey,
    edited: new Set(),
    unconfirmedEdited: new Set()
  })
  const [state, setState] = useState<State>(empty)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  const currentRef = useRef(state)
  const contextRef = useRef({ storageKey, scopePrefix, onStorageError })
  contextRef.current = { storageKey, scopePrefix, onStorageError }
  if (currentRef.current.identity !== identity) {
    const next = empty()
    currentRef.current = next
    surfaces.current.clear()
    reconciled.current = false
    setState(next)
  }
  const warnedRef = useRef(false)
  const reportError = useCallback(() => {
    if (!warnedRef.current) {
      warnedRef.current = true
      contextRef.current.onStorageError?.()
    }
  }, [])

  const persist = useCallback(
    (snapshot: State): Promise<void> => {
      const { storageKey: key, scopePrefix: prefix } = contextRef.current
      if (!key || !snapshot.loaded) {
        return Promise.resolve()
      }
      const savedSurfaces = Object.fromEntries(
        [...surfaces.current].filter(
          ([, handle]) =>
            Object.hasOwn(snapshot.drafts, handle) || Object.hasOwn(snapshot.unconfirmed, handle)
        )
      )
      const write = (writes.get(key) ?? Promise.resolve()).then(async () => {
        const previous = await AsyncStorage.getItem(key)
        const stored = parseStoredDrafts(previous)
        const scoped = (old: Drafts, next: Drafts): Drafts => ({
          ...Object.fromEntries(Object.entries(old).filter(([name]) => !name.startsWith(prefix))),
          ...Object.fromEntries(Object.entries(next).map(([name, text]) => [prefix + name, text]))
        })
        const next = {
          drafts: scoped(
            stored.drafts,
            Object.fromEntries(
              Object.entries(snapshot.drafts).filter(([, text]) => text.length > 0)
            )
          ),
          unconfirmed: scoped(stored.unconfirmed, snapshot.unconfirmed),
          surfaces: scoped(stored.surfaces, savedSurfaces)
        }
        if (
          previous === null &&
          Object.values(next).every((record) => Object.keys(record).length === 0)
        ) {
          return
        }
        const raw = JSON.stringify(next)
        if (raw !== previous) {
          await persistMirrored(key, raw)
          if ((await AsyncStorage.getItem(key)) !== raw) {
            throw new Error('Command draft storage refused the write')
          }
        }
      })
      const barrier = write.catch(reportError)
      writes.set(key, barrier)
      void barrier.then(() => {
        if (writes.get(key) === barrier) {
          writes.delete(key)
        }
      })
      return write
    },
    [reportError, surfaces]
  )

  const update = useCallback(
    (field: 'drafts' | 'unconfirmed', value: SetStateAction<Drafts>) => {
      if (!mountedRef.current) {
        return
      }
      const current = currentRef.current
      const nextValues = typeof value === 'function' ? value(current[field]) : value
      if (nextValues === current[field]) {
        return
      }
      const changed = [
        ...new Set([...Object.keys(current[field]), ...Object.keys(nextValues)])
      ].filter((handle) => current[field][handle] !== nextValues[handle])
      const changedField = field === 'drafts' ? 'edited' : 'unconfirmedEdited'
      const next = {
        ...current,
        [field]: nextValues,
        [changedField]: new Set([...current[changedField], ...changed])
      }
      currentRef.current = next
      setState(next)
      void persist(next).catch(() => {})
    },
    [persist]
  )
  const setDrafts = useCallback(
    (value: SetStateAction<Drafts>) => update('drafts', value),
    [update]
  )
  const setUnconfirmed = useCallback(
    (value: SetStateAction<Drafts>) => update('unconfirmed', value),
    [update]
  )
  const prepareSend = useCallback(async (): Promise<boolean> => {
    const snapshot = currentRef.current
    if (!snapshot.loaded) {
      return false
    }
    try {
      await persist(snapshot)
      return mountedRef.current && currentRef.current.identity === snapshot.identity
    } catch {
      return false
    }
  }, [persist])
  const readDraft = useCallback((handle: string) => currentRef.current.drafts[handle] ?? '', [])
  const recoveryReady = useCallback(() => currentRef.current.loaded, [])

  useEffect(() => {
    warnedRef.current = false
    if (!storageKey) {
      return
    }
    let cancelled = false
    void (writes.get(storageKey) ?? Promise.resolve())
      .then(() => AsyncStorage.getItem(storageKey))
      .then((raw) => {
        if (cancelled || currentRef.current.identity !== identity) {
          return
        }
        const stored = parseStoredDrafts(raw)
        const scoped = (record: Drafts) =>
          Object.fromEntries(
            Object.entries(record)
              .filter(([name]) => name.startsWith(scopePrefix))
              .map(([name, text]) => [name.slice(scopePrefix.length), text])
          )
        const scopeDrafts = scoped(stored.drafts)
        const scopeUnconfirmed = scoped(stored.unconfirmed)
        const restored: Drafts = {}
        const restoredUnconfirmed: Drafts = {}
        for (const [surface, handle] of Object.entries(scoped(stored.surfaces))) {
          const target = surfaces.current.get(surface)
          if (!target && reconciled.current) {
            continue
          }
          if (!target) {
            surfaces.current.set(surface, handle)
          }
          const nextHandle = target ?? handle
          if (Object.hasOwn(scopeDrafts, handle)) {
            restored[nextHandle] = scopeDrafts[handle]
          }
          if (Object.hasOwn(scopeUnconfirmed, handle)) {
            restoredUnconfirmed[nextHandle] = scopeUnconfirmed[handle]
          }
        }
        const current = currentRef.current
        const next = {
          ...current,
          loaded: true,
          drafts: {
            ...Object.fromEntries(
              Object.entries(restored).filter(([handle]) => !current.edited.has(handle))
            ),
            ...current.drafts
          },
          unconfirmed: {
            ...Object.fromEntries(
              Object.entries(restoredUnconfirmed).filter(
                ([handle]) => !current.unconfirmedEdited.has(handle)
              )
            ),
            ...current.unconfirmed
          }
        }
        currentRef.current = next
        setState(next)
        void persist(next).catch(() => {})
      })
      .catch(reportError)
    return () => {
      cancelled = true
    }
  }, [identity, storageKey, scopePrefix, surfaces, reconciled, persist, reportError])

  const current = state.identity === identity ? state : currentRef.current
  return {
    drafts: current.drafts,
    unconfirmed: current.unconfirmed,
    setDrafts,
    setUnconfirmed,
    prepareSend,
    readDraft,
    recoveryReady
  }
}
