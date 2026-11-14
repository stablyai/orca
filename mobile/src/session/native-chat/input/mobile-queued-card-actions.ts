import { useCallback, useMemo, useSyncExternalStore } from 'react'

const NO_IDS: ReadonlySet<string> = new Set()

type CardAction = (messageId: string) => Promise<boolean>

/** One chat's queued-card actions: which cards have one on its way, and admitting the next. */
export type MobileQueuedCardActions = {
  busyIds: ReadonlySet<string>
  /** Admits the action unless its card or a resource it takes already has one on its way. */
  run: (messageId: string, action?: CardAction, resources?: readonly string[]) => boolean
}

export type MobileQueuedCardActionStore = ReturnType<typeof createMobileQueuedCardActionStore>

// Owned above the list: a list remounted for the same chat still sees an action on its way, and the
// composer's Steer queued cue reads the same guard the press does (desktop's queued-messages controller).
export function createMobileQueuedCardActionStore() {
  const pending = new Map<string, Set<string>>()
  const shown = new Map<string, ReadonlySet<string>>()
  const listeners = new Set<() => void>()
  // Copies only the chat that changed, so other chats' pending actions cost nothing here.
  const publish = (chat: string): void => {
    const keys = pending.get(chat)
    if (keys && keys.size > 0) {
      shown.set(chat, new Set(keys))
    } else {
      pending.delete(chat)
      shown.delete(chat)
    }
    listeners.forEach((listener) => listener())
  }
  return {
    read: (chat: string): ReadonlySet<string> => shown.get(chat) ?? NO_IDS,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    run: (
      chat: string,
      messageId: string,
      action?: CardAction,
      resources: readonly string[] = []
    ): boolean => {
      const keys = [messageId, ...resources]
      const held = pending.get(chat) ?? new Set<string>()
      if (!action || keys.some((key) => held.has(key))) {
        return false
      }
      keys.forEach((key) => held.add(key))
      pending.set(chat, held)
      publish(chat)
      void (async () => {
        try {
          await action(messageId)
        } finally {
          // Only this action's own keys: another one admitted since keeps its hold.
          keys.forEach((key) => held.delete(key))
          publish(chat)
        }
      })()
      return true
    }
  }
}

export function useMobileQueuedCardActions(
  store: MobileQueuedCardActionStore,
  chat: string
): MobileQueuedCardActions {
  const busyIds = useSyncExternalStore(store.subscribe, () => store.read(chat))
  const run = useCallback<MobileQueuedCardActions['run']>(
    (messageId, action, resources) => store.run(chat, messageId, action, resources),
    [store, chat]
  )
  return useMemo(() => ({ busyIds, run }), [busyIds, run])
}
