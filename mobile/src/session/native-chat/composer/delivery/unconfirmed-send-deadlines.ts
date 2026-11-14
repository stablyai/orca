// How long a send whose acknowledgement was lost waits for the transcript or journal to confirm it.
export const UNCONFIRMED_SEND_DEADLINE_MS = 20_000

/** Deadlines that count only connected time: nothing can confirm a send while the host is out. */
export type UnconfirmedSendDeadlines<Key> = {
  hold: (key: Key, fire: () => void) => void
  cancel: (key: Key) => void
  keys: () => Key[]
  setConnected: (connected: boolean) => void
  clear: () => void
}

type Deadline = {
  timer: ReturnType<typeof setTimeout> | null
  fire: () => void
  remainingMs: number
  startedAt: number
}

export function createUnconfirmedSendDeadlines<Key>(): UnconfirmedSendDeadlines<Key> {
  const held = new Map<Key, Deadline>()
  let connected = true
  const start = (key: Key, entry: Deadline): void => {
    entry.startedAt = Date.now()
    entry.timer = setTimeout(() => {
      held.delete(key)
      entry.fire()
    }, entry.remainingMs)
  }
  const pause = (entry: Deadline): void => {
    if (entry.timer !== null) {
      clearTimeout(entry.timer)
      entry.timer = null
      entry.remainingMs = Math.max(0, entry.remainingMs - (Date.now() - entry.startedAt))
    }
  }
  return {
    // Holding a key again replaces its deadline, so a later owner's hand-back wins.
    hold: (key, fire) => {
      const previous = held.get(key)
      if (previous) {
        pause(previous)
      }
      const entry: Deadline = {
        timer: null,
        fire,
        remainingMs: UNCONFIRMED_SEND_DEADLINE_MS,
        startedAt: 0
      }
      held.set(key, entry)
      if (connected) {
        start(key, entry)
      }
    },
    cancel: (key) => {
      const entry = held.get(key)
      if (entry) {
        pause(entry)
        held.delete(key)
      }
    },
    keys: () => [...held.keys()],
    setConnected: (next) => {
      connected = next
      for (const [key, entry] of held) {
        if (!next) {
          pause(entry)
        } else if (entry.timer === null) {
          start(key, entry)
        }
      }
    },
    clear: () => {
      for (const entry of held.values()) {
        pause(entry)
      }
      held.clear()
    }
  }
}
