import { useSyncExternalStore } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { persistMirrored } from '../storage/mirrored-storage-keys'

export const DUO_CHAT_EXPANDED_KEY = 'orca:duoChatExpanded'

// One device-wide choice. Expanded until the user collapses it.
let expanded = true
let revision = 0
let settledRevision = 0
let writeChain: Promise<void> = Promise.resolve()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

function publish(next: boolean): void {
  if (next === expanded) {
    return
  }
  expanded = next
  emit()
}

function fromStored(raw: string | null): boolean {
  return raw !== 'false'
}

async function reload(): Promise<void> {
  const loadRevision = revision
  await writeChain
  if (revision !== loadRevision) {
    return
  }
  let raw: string | null
  try {
    raw = await AsyncStorage.getItem(DUO_CHAT_EXPANDED_KEY)
  } catch {
    return
  }
  if (revision !== loadRevision) {
    return
  }
  settledRevision = loadRevision
  publish(fromStored(raw))
}

export function toggleDuoChatExpanded(): void {
  revision += 1
  publish(!expanded)
  const value = String(expanded)
  const written = revision
  writeChain = writeChain
    .then(() => persistMirrored(DUO_CHAT_EXPANDED_KEY, value))
    .then(async () => {
      if (revision !== written) {
        return
      }
      const raw = await AsyncStorage.getItem(DUO_CHAT_EXPANDED_KEY)
      if (revision !== written) {
        return
      }
      settledRevision = written
      publish(fromStored(raw))
    })
    .catch((error: unknown) => {
      console.warn('Duo chat width could not be saved', error)
      if (revision === written) {
        settledRevision = written
      }
    })
}

/** A value already stored for another open chat. A toggle that has not landed yet wins. */
export function applyStoredDuoChatExpanded(raw: string | null): void {
  if (revision !== settledRevision) {
    return
  }
  const next = fromStored(raw)
  if (next === expanded) {
    return
  }
  revision += 1
  settledRevision = revision
  publish(next)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    void reload()
  }
  return () => {
    listeners.delete(listener)
  }
}

/** Whether chats run across the iPhone Duo's status column (true) or keep clear of it. */
export function useDuoChatExpanded(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => expanded,
    () => expanded
  )
}
