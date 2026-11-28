// Phone-only. The host screen is a page, and that page's localStorage is empty after every remount.
import { useSyncExternalStore } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { persistMirrored } from '../storage/mirrored-storage-keys'

export const SELECTABLE_SIDEBAR_SESSIONS_KEY = 'orca:selectableSidebarSessions'
const LEGACY_SELECTABLE_SIDEBAR_SESSIONS_KEY = 'orca.selectableSidebarSessions'

let selectable = false
let revision = 0
let writeChain: Promise<void> = Promise.resolve()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

function publish(next: boolean): void {
  if (next === selectable) {
    return
  }
  selectable = next
  emit()
}

export function getSelectableSidebarSessions(): boolean {
  return selectable
}

async function readKey(key: string): Promise<string | null | undefined> {
  try {
    return await AsyncStorage.getItem(key)
  } catch {
    return undefined
  }
}

// A build that stored the dot key still has it in the native shell. The page never kept that key.
async function adoptLegacy(loadRevision: number): Promise<void> {
  if (revision !== loadRevision) {
    return
  }
  const legacy = await readKey(LEGACY_SELECTABLE_SIDEBAR_SESSIONS_KEY)
  if (legacy !== '1' && legacy !== '0') {
    return
  }
  if (revision !== loadRevision) {
    return
  }
  await persistMirrored(SELECTABLE_SIDEBAR_SESSIONS_KEY, legacy)
  if (revision !== loadRevision) {
    return
  }
  try {
    await AsyncStorage.removeItem(LEGACY_SELECTABLE_SIDEBAR_SESSIONS_KEY)
  } catch {
    // The dot key is not a page key. The colon key is already saved.
  }
  if (revision === loadRevision) {
    publish(legacy === '1')
  }
}

async function reload(): Promise<void> {
  const loadRevision = revision
  await writeChain
  if (revision !== loadRevision) {
    return
  }
  const raw = await readKey(SELECTABLE_SIDEBAR_SESSIONS_KEY)
  if (raw === undefined || revision !== loadRevision) {
    return
  }
  if (raw === null) {
    writeChain = writeChain.then(() => adoptLegacy(loadRevision)).catch(() => undefined)
    await writeChain
    return
  }
  publish(raw === '1')
}

export function setSelectableSidebarSessions(next: boolean): void {
  revision += 1
  publish(next)
  const value = next ? '1' : '0'
  writeChain = writeChain
    .then(() => persistMirrored(SELECTABLE_SIDEBAR_SESSIONS_KEY, value))
    .catch((error: unknown) => console.warn('Select sessions could not be saved', error))
}

// Re-read when the first reader mounts. Page storage arrives with init, after this module loads.
export function subscribeSelectableSidebarSessions(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    void reload()
  }
  return () => {
    listeners.delete(listener)
  }
}

export function useSelectableSidebarSessions(): boolean {
  return useSyncExternalStore(
    subscribeSelectableSidebarSessions,
    getSelectableSidebarSessions,
    getSelectableSidebarSessions
  )
}
