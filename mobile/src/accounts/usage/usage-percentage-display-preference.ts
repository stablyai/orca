import { useSyncExternalStore } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  normalizeUsagePercentageDisplay,
  type UsagePercentageDisplay
} from '../../../../src/shared/agent-usage/display/usage-percentage-display'
import { useShellStorage } from '../../platform/shell-storage/shell-storage'
import { persistMirrored } from '../../storage/mirrored-storage-keys'

// Per device, like desktop's setting: one phone can show remaining while the desktop shows used.
export const USAGE_PERCENTAGE_DISPLAY_KEY = 'orca:usagePercentageDisplay'

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
    raw = await AsyncStorage.getItem(USAGE_PERCENTAGE_DISPLAY_KEY)
  } catch {
    return
  }
  // A choice made while reading is newer than what storage held.
  if (revision === loadRevision) {
    publish(normalizeUsagePercentageDisplay(raw))
  }
}

// Read once at load so the first bars a native screen draws already use the saved choice.
void reload()

export function setUsagePercentageDisplay(display: UsagePercentageDisplay): void {
  revision += 1
  publish(display)
  writeChain = writeChain
    .then(() => persistMirrored(USAGE_PERCENTAGE_DISPLAY_KEY, display))
    .catch((error: unknown) => console.warn('Usage percentage display could not be saved', error))
}

// Re-read when the first reader mounts, so a screen opened after Settings shows the saved choice.
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

/** Whether this phone's usage bars show the percentage used (default) or remaining. */
export function useUsagePercentageDisplay(): UsagePercentageDisplay {
  // A page reads the app's copy, which the app republishes when Settings changes it.
  const shellStorage = useShellStorage()
  const saved = useSyncExternalStore(subscribe, read, read)
  return shellStorage === null
    ? saved
    : normalizeUsagePercentageDisplay(shellStorage[USAGE_PERCENTAGE_DISPLAY_KEY])
}
