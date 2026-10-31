import { useSyncExternalStore } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'

const DUO_CHAT_EXPANDED_KEY = 'orca:duoChatExpanded'

// One choice for every chat, kept across relaunches; expanded until the user collapses it.
let expanded = true
let hydrated = false
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!hydrated) {
    hydrated = true
    void AsyncStorage.getItem(DUO_CHAT_EXPANDED_KEY)
      .then((raw) => {
        if (raw === 'false' && expanded) {
          expanded = false
          notify()
        }
      })
      .catch(() => {})
  }
  return () => {
    listeners.delete(listener)
  }
}

export function toggleDuoChatExpanded(): void {
  expanded = !expanded
  void AsyncStorage.setItem(DUO_CHAT_EXPANDED_KEY, String(expanded)).catch(() => {})
  notify()
}

/** Whether chats run across the iPhone Duo's status column (true) or keep clear of it. */
export function useDuoChatExpanded(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => expanded,
    () => expanded
  )
}
