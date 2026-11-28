import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { triggerSelection } from '../../../../platform/haptics/haptics'

/** Which control started a card's action, so that one shows it pending. */
export type MobileQueuedCardControl = 'send' | 'more' | 'move' | 'deleteAll' | 'resume'

const NO_IDS: ReadonlyMap<string, MobileQueuedCardControl> = new Map()

type CardAction = (messageId: string) => Promise<boolean>

/** One chat's queued-card actions: which cards have one on its way (and from which control), and admitting the next. */
export type MobileQueuedCardActions = {
  busyIds: ReadonlyMap<string, MobileQueuedCardControl>
  /** Admits the action unless its card or a resource it takes already has one on its way. */
  run: (
    messageId: string,
    action?: CardAction,
    resources?: readonly string[],
    control?: MobileQueuedCardControl
  ) => boolean
}

export type MobileQueuedCardActionStore = ReturnType<typeof createMobileQueuedCardActionStore>

// Owned above the list: a list remounted for the same chat still sees an action on its way, and the
// composer's Steer queued cue reads the same guard the press does (desktop's queued-messages controller).
export function createMobileQueuedCardActionStore() {
  const pending = new Map<string, Map<string, MobileQueuedCardControl>>()
  const shown = new Map<string, ReadonlyMap<string, MobileQueuedCardControl>>()
  const listeners = new Set<() => void>()
  // Copies only the chat that changed, so other chats' pending actions cost nothing here.
  const publish = (chat: string): void => {
    const keys = pending.get(chat)
    if (keys && keys.size > 0) {
      shown.set(chat, new Map(keys))
    } else {
      pending.delete(chat)
      shown.delete(chat)
    }
    listeners.forEach((listener) => listener())
  }
  return {
    read: (chat: string): ReadonlyMap<string, MobileQueuedCardControl> => shown.get(chat) ?? NO_IDS,
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
      resources: readonly string[] = [],
      control: MobileQueuedCardControl = 'send'
    ): boolean => {
      const keys = [messageId, ...resources]
      const held = pending.get(chat) ?? new Map<string, MobileQueuedCardControl>()
      if (!action || keys.some((key) => held.has(key))) {
        return false
      }
      keys.forEach((key) => held.set(key, control))
      pending.set(chat, held)
      publish(chat)
      // The send-start tick; a drag's drop keeps the drag's own feel.
      if (control !== 'move') {
        triggerSelection()
      }
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
    (messageId, action, resources, control) =>
      store.run(chat, messageId, action, resources, control),
    [store, chat]
  )
  return useMemo(() => ({ busyIds, run }), [busyIds, run])
}
