import { useSyncExternalStore } from 'react'

// Text a draft-mode write could not send yet. Page memory only: it outlives the sheet, not the app.
let drafts: ReadonlyMap<string, string> = new Map()
const listeners = new Set<() => void>()

export function readHostMutationDraft(key: string): string | undefined {
  return drafts.get(key)
}

export function setHostMutationDraft(key: string, text: string | null): void {
  if (drafts.get(key) === (text ?? undefined)) {
    return
  }
  const next = new Map(drafts)
  if (text === null) {
    next.delete(key)
  } else {
    next.set(key, text)
  }
  drafts = next
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useHostMutationDrafts(): ReadonlyMap<string, string> {
  return useSyncExternalStore(subscribe, () => drafts)
}
