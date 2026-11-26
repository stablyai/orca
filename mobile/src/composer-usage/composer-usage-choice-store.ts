import { useSyncExternalStore } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { persistMirrored } from '../storage/mirrored-storage-keys'

export type ComposerUsageChoiceStore<T extends string> = {
  set: (next: T) => void
  use: () => T
}

/** One device-wide composer meter choice, persisted under `key` and shared by every reader. */
export function createComposerUsageChoiceStore<T extends string>(
  key: string,
  normalize: (raw: string | null | undefined) => T,
  name: string
): ComposerUsageChoiceStore<T> {
  let current: T = normalize(undefined)
  let revision = 0
  let writeChain: Promise<void> = Promise.resolve()
  const listeners = new Set<() => void>()

  const publish = (next: T): void => {
    if (next === current) {
      return
    }
    current = next
    for (const listener of listeners) {
      listener()
    }
  }

  const reload = async (): Promise<void> => {
    const loadRevision = revision
    await writeChain
    let raw: string | null
    try {
      raw = await AsyncStorage.getItem(key)
    } catch {
      return
    }
    // A choice made while reading is newer than what storage held.
    if (revision === loadRevision) {
      publish(normalize(raw))
    }
  }

  // Re-read when the first reader mounts: the page's storage arrives with each init, after module load.
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    if (listeners.size === 1) {
      void reload()
    }
    return () => {
      listeners.delete(listener)
    }
  }

  const read = (): T => current

  return {
    set: (next) => {
      revision += 1
      publish(next)
      writeChain = writeChain
        .then(() => persistMirrored(key, next))
        .catch((error: unknown) => console.warn(`${name} could not be saved`, error))
    },
    use: () => useSyncExternalStore(subscribe, read, read)
  }
}
