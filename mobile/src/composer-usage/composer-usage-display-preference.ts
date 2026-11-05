import { useSyncExternalStore } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  normalizeUsagePercentageDisplay,
  type UsagePercentageDisplay
} from '../../../src/shared/usage-percentage-display'
import { persistMirrored } from '../storage/mirrored-storage-keys'

export const COMPOSER_USAGE_DISPLAY_KEY = 'orca:composerUsageDisplay'

let current: UsagePercentageDisplay = normalizeUsagePercentageDisplay(undefined)
let revision = 0
let writeChain: Promise<void> = Promise.resolve()
const listeners = new Set<() => void>()

function publish(next: UsagePercentageDisplay): void {
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
    raw = await AsyncStorage.getItem(COMPOSER_USAGE_DISPLAY_KEY)
  } catch {
    return
  }
  // A choice made while reading is newer than what storage held.
  if (revision === loadRevision) {
    publish(normalizeUsagePercentageDisplay(raw))
  }
}

export function setComposerUsageDisplay(display: UsagePercentageDisplay): void {
  revision += 1
  publish(display)
  writeChain = writeChain
    .then(() => persistMirrored(COMPOSER_USAGE_DISPLAY_KEY, display))
    .catch((error: unknown) => console.warn('Composer usage display could not be saved', error))
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

const read = (): UsagePercentageDisplay => current

/** Whether every composer meter on this device shows used (default) or remaining. */
export function useComposerUsageDisplay(): UsagePercentageDisplay {
  return useSyncExternalStore(subscribe, read, read)
}
