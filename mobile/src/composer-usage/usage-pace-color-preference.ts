import { useMemo, useSyncExternalStore } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useShellStorage } from '../platform/shell-storage/shell-storage'
import { persistMirrored, subscribeMirroredKey } from '../storage/mirrored-storage-keys'
import {
  DEFAULT_USAGE_PACE_COLOR_THRESHOLDS,
  isDefaultUsagePaceColorThresholds,
  normalizeUsagePaceColorThresholds,
  parseUsagePaceColorThresholds,
  serializeUsagePaceColorThresholds,
  type UsagePaceColorThresholds
} from './usage-pace-color'

export {
  isDefaultUsagePaceColorThresholds,
  parseUsagePaceColorThresholds,
  serializeUsagePaceColorThresholds
}

export const USAGE_PACE_COLOR_THRESHOLDS_KEY = 'orca:usagePaceColorThresholds'

let current: UsagePaceColorThresholds = DEFAULT_USAGE_PACE_COLOR_THRESHOLDS
let revision = 0
let writeChain: Promise<void> = Promise.resolve()
const listeners = new Set<() => void>()

function publish(next: UsagePaceColorThresholds): void {
  if (
    next.greenMaxOverPacePct === current.greenMaxOverPacePct &&
    next.yellowMaxOverPacePct === current.yellowMaxOverPacePct
  ) {
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
    raw = await AsyncStorage.getItem(USAGE_PACE_COLOR_THRESHOLDS_KEY)
  } catch {
    return
  }
  if (revision === loadRevision) {
    publish(parseUsagePaceColorThresholds(raw))
  }
}

void reload()

subscribeMirroredKey(USAGE_PACE_COLOR_THRESHOLDS_KEY, (raw, source) => {
  if (source === 'page') {
    revision += 1
    publish(parseUsagePaceColorThresholds(raw))
  }
})

export function setUsagePaceColorThresholds(thresholds: UsagePaceColorThresholds): void {
  const normalized = normalizeUsagePaceColorThresholds({
    greenMaxOverPacePct: Math.round(thresholds.greenMaxOverPacePct),
    yellowMaxOverPacePct: Math.round(thresholds.yellowMaxOverPacePct)
  })
  revision += 1
  publish(normalized)
  writeChain = writeChain
    .then(() => persistMirrored(USAGE_PACE_COLOR_THRESHOLDS_KEY, JSON.stringify(normalized)))
    .catch((error: unknown) =>
      console.warn('Usage pace color thresholds could not be saved', error)
    )
}

export function resetUsagePaceColorThresholds(): void {
  setUsagePaceColorThresholds(DEFAULT_USAGE_PACE_COLOR_THRESHOLDS)
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

const read = (): UsagePaceColorThresholds => current

/** Device-wide pace color thresholds, synced live between Settings, rail rings, and composer meters. */
export function useUsagePaceColorThresholds(): UsagePaceColorThresholds {
  const shellStorage = useShellStorage()
  const saved = useSyncExternalStore(subscribe, read, read)
  const shellRaw = shellStorage?.[USAGE_PACE_COLOR_THRESHOLDS_KEY]
  const fromShell = useMemo(() => parseUsagePaceColorThresholds(shellRaw), [shellRaw])
  return shellStorage === null ? saved : fromShell
}
