// How long a send whose acknowledgement was lost waits for the transcript or journal to confirm it.
export const UNCONFIRMED_SEND_DEADLINE_MS = 20_000

/** Deadlines that run only while connected: nothing can confirm a send while the host is out. */
export type UnconfirmedSendDeadlines<Key> = {
  hold: (key: Key, fire: () => void) => void
  cancel: (key: Key) => void
  keys: () => Key[]
  setConnected: (connected: boolean) => void
  clear: () => void
}

export function createUnconfirmedSendDeadlines<Key>(): UnconfirmedSendDeadlines<Key> {
  const held = new Map<Key, { timer: ReturnType<typeof setTimeout> | null; fire: () => void }>()
  let connected = true
  const start = (key: Key): void => {
    const entry = held.get(key)
    if (entry && entry.timer === null) {
      entry.timer = setTimeout(() => {
        held.delete(key)
        entry.fire()
      }, UNCONFIRMED_SEND_DEADLINE_MS)
    }
  }
  return {
    hold: (key, fire) => {
      held.set(key, { timer: null, fire })
      if (connected) {
        start(key)
      }
    },
    cancel: (key) => {
      clearTimeout(held.get(key)?.timer ?? undefined)
      held.delete(key)
    },
    keys: () => [...held.keys()],
    setConnected: (next) => {
      connected = next
      for (const [key, entry] of held) {
        if (next) {
          start(key)
        } else {
          clearTimeout(entry.timer ?? undefined)
          entry.timer = null
        }
      }
    },
    clear: () => {
      for (const entry of held.values()) {
        clearTimeout(entry.timer ?? undefined)
      }
      held.clear()
    }
  }
}
