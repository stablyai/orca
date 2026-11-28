import AsyncStorage from '@react-native-async-storage/async-storage'
import { useEffect, useSyncExternalStore } from 'react'
import { useShellStorage } from '../../../platform/shell-storage/shell-storage'
import {
  persistMirroredReadBack,
  subscribeMirroredKey
} from '../../../storage/mirrored-storage-keys'

export const CHAT_HARDWARE_ENTER_KEY = 'orca:chatHardwareEnterToSend'

let enabled = false
let revision = 0
let writes = Promise.resolve()
const listeners = new Set<() => void>()

function adopt(raw: string | null): void {
  const next = raw === 'true'
  if (next !== enabled) {
    enabled = next
    for (const listener of listeners) {
      listener()
    }
  }
}

function reload(): void {
  const started = revision
  void writes
    .then(() => AsyncStorage.getItem(CHAT_HARDWARE_ENTER_KEY))
    .then((raw) => {
      if (started === revision) {
        adopt(raw)
      }
    })
    .catch(() => undefined)
}

subscribeMirroredKey(CHAT_HARDWARE_ENTER_KEY, (raw, source) => {
  if (source === 'page') {
    revision += 1
    adopt(raw)
  }
})

const REPAIR_ATTEMPTS = 3

// A newer revision can land after this write. Repair stores what it adopted, and stops after a few tries.
function repairStored(attemptsLeft: number): Promise<void> {
  if (attemptsLeft <= 0) {
    return Promise.resolve()
  }
  const started = revision
  const value = String(enabled)
  return persistMirroredReadBack(CHAT_HARDWARE_ENTER_KEY, value)
    .then((stored) => {
      if (revision !== started) {
        return repairStored(attemptsLeft - 1)
      }
      if (stored !== value) {
        adopt(stored)
      }
    })
    .catch(() => {
      if (revision === started) {
        reload()
        return
      }
      return repairStored(attemptsLeft - 1)
    })
}

export function setChatHardwareEnterToSend(next: boolean): Promise<void> {
  const changed = ++revision
  adopt(String(next))
  writes = writes
    .then(() => persistMirroredReadBack(CHAT_HARDWARE_ENTER_KEY, String(next)))
    .then((raw) => {
      if (revision === changed) {
        adopt(raw)
        return
      }
      return repairStored(REPAIR_ATTEMPTS)
    })
    .catch(() => {
      if (revision === changed) {
        reload()
        return
      }
      return repairStored(REPAIR_ATTEMPTS)
    })
  return writes
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useChatHardwareEnterToSend(): boolean {
  const storage = useShellStorage()
  useEffect(reload, [storage])
  return useSyncExternalStore(
    subscribe,
    () => enabled,
    () => false
  )
}
