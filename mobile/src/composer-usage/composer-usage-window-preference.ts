import { useSyncExternalStore } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { persistMirrored } from '../storage/mirrored-storage-keys'
import type { ComposerUsageWindowChoice } from './agent-usage-provider'

export const COMPOSER_USAGE_WINDOW_KEY = 'orca:composerUsageWindow'
const DEFAULT_CHOICE: ComposerUsageWindowChoice = 'session'

let current: ComposerUsageWindowChoice = DEFAULT_CHOICE
let revision = 0
let writeChain: Promise<void> = Promise.resolve()
const listeners = new Set<() => void>()

function publish(next: ComposerUsageWindowChoice): void {
  if (next === current) {
    return
  }
  current = next
  for (const listener of listeners) {
    listener()
  }
}

async function reload(): Promise<void> {
  const loadRevision = revision
  await writeChain
  let raw: string | null
  try {
    raw = await AsyncStorage.getItem(COMPOSER_USAGE_WINDOW_KEY)
  } catch {
    return
  }
  // A choice made while reading is newer than what storage held.
  if (revision === loadRevision) {
    publish(raw === 'weekly' ? 'weekly' : DEFAULT_CHOICE)
  }
}

export function setComposerUsageWindow(choice: ComposerUsageWindowChoice): void {
  revision += 1
  publish(choice)
  writeChain = writeChain
    .then(() => persistMirrored(COMPOSER_USAGE_WINDOW_KEY, choice))
    .catch((error: unknown) => console.warn('Composer usage window could not be saved', error))
}

// Re-read when the first reader mounts: the page's storage arrives with each init, after module load.
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    void reload()
  }
  return () => {
    listeners.delete(listener)
  }
}

const read = (): ComposerUsageWindowChoice => current

/** Which window the composer meter shows on this device: the 5-hour session (default) or weekly. */
export function useComposerUsageWindow(): ComposerUsageWindowChoice {
  return useSyncExternalStore(subscribe, read, read)
}
