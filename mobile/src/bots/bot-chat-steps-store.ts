import { useSyncExternalStore } from 'react'

// How many "Show more workers" steps each chat in the host list took; kept while the app runs, like the desktop's.
let steps: Readonly<Record<string, number>> = {}
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const readSteps = (): Readonly<Record<string, number>> => steps

/** Sets one chat's steps, keyed by `botChatFoldKey`; 0 shows the first page again. */
export function setBotChatSteps(key: string, next: number): void {
  if ((steps[key] ?? 0) === Math.max(next, 0)) {
    return
  }
  const { [key]: _dropped, ...rest } = steps
  steps = next > 0 ? { ...rest, [key]: next } : rest
  listeners.forEach((listener) => listener())
}

export function useBotChatSteps(): Readonly<Record<string, number>> {
  return useSyncExternalStore(subscribe, readSteps, readSteps)
}
