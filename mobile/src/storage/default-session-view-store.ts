import { useEffect, useSyncExternalStore } from 'react'
import {
  DEFAULT_SESSION_VIEW,
  loadDefaultSessionView,
  saveDefaultSessionView,
  type MobileSessionView
} from './session-view-preferences'

/** The per-device default view; `settled` is false only until the first read answers. */
export type DefaultSessionViewState = { value: MobileSessionView; settled: boolean }

// One owner per JS context, so Settings and every mounted session read the same value.
let state: DefaultSessionViewState = { value: DEFAULT_SESSION_VIEW, settled: false }
let mutationRevision = 0
let loadStarted = false
const listeners = new Set<() => void>()

function publish(next: DefaultSessionViewState): void {
  if (next.value === state.value && next.settled === state.settled) {
    return
  }
  state = next
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

function readState(): DefaultSessionViewState {
  return state
}

/** Re-reads storage; a change written by the other JS context of a hybrid page lands here. */
export function refreshDefaultSessionView(): Promise<void> {
  loadStarted = true
  const revision = mutationRevision
  return loadDefaultSessionView()
    .catch(() => DEFAULT_SESSION_VIEW)
    .then((value) => {
      // Why: a choice made during the read is newer than what the read saw.
      if (mutationRevision === revision) {
        publish({ value, settled: true })
      }
    })
}

export function setDefaultSessionView(view: MobileSessionView): void {
  const revision = mutationRevision + 1
  mutationRevision = revision
  publish({ value: view, settled: true })
  // Why: persistence owns a shared queue, so invoking it at event time preserves mutation order.
  void saveDefaultSessionView(view).catch(async () => {
    const persisted = await loadDefaultSessionView().catch(() => DEFAULT_SESSION_VIEW)
    if (mutationRevision === revision) {
      publish({ value: persisted, settled: true })
    }
  })
}

export function useDefaultSessionView(): DefaultSessionViewState {
  useEffect(() => {
    if (!loadStarted) {
      void refreshDefaultSessionView()
    }
  }, [])
  return useSyncExternalStore(subscribe, readState, readState)
}

export function resetDefaultSessionViewStoreForTests(): void {
  state = { value: DEFAULT_SESSION_VIEW, settled: false }
  mutationRevision = 0
  loadStarted = false
  listeners.clear()
}
