import { useEffect, useSyncExternalStore } from 'react'
import {
  DEFAULT_SESSION_VIEW,
  readDefaultSessionViewPreference,
  saveDefaultSessionView,
  type MobileSessionView
} from './session-view-preferences'
import {
  readDefaultSessionViewState,
  writeDefaultSessionViewState,
  type DefaultSessionViewState
} from './default-session-view-state'

export type { DefaultSessionViewState }

const INITIAL_STATE: DefaultSessionViewState = {
  value: DEFAULT_SESSION_VIEW,
  settled: false,
  hasStoredValue: false
}
let mutationRevision = 0
let loadStarted = false
const listeners = new Set<() => void>()

function publish(next: DefaultSessionViewState): void {
  const state = readState()
  if (
    next.value === state.value &&
    next.settled === state.settled &&
    next.hasStoredValue === state.hasStoredValue
  ) {
    return
  }
  writeDefaultSessionViewState(next)
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

// One owner per JS context, so Settings and every mounted session read the same value.
function readState(): DefaultSessionViewState {
  return readDefaultSessionViewState() ?? INITIAL_STATE
}

// Why: a failed read is not a stored choice, so launches leave the view to the host.
async function readStoredState(): Promise<DefaultSessionViewState> {
  let preference: Awaited<ReturnType<typeof readDefaultSessionViewPreference>> | null = null
  try {
    preference = await readDefaultSessionViewPreference()
  } catch {
    // Treated as no stored choice below.
  }
  return {
    value: preference?.value ?? DEFAULT_SESSION_VIEW,
    settled: true,
    hasStoredValue: preference?.hasStoredValue ?? false
  }
}

/** Re-reads storage; a change written by the other JS context of a hybrid page lands here. */
export function refreshDefaultSessionView(): Promise<void> {
  loadStarted = true
  const revision = mutationRevision
  return readStoredState().then((next) => {
    // Why: a choice made during the read is newer than what the read saw.
    if (mutationRevision === revision) {
      publish(next)
    }
  })
}

export function setDefaultSessionView(view: MobileSessionView): void {
  const revision = mutationRevision + 1
  mutationRevision = revision
  publish({ value: view, settled: true, hasStoredValue: true })
  // Why: persistence owns a shared queue, so invoking it at event time preserves mutation order.
  void saveDefaultSessionView(view).catch(async () => {
    const persisted = await readStoredState()
    if (mutationRevision === revision) {
      publish(persisted)
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
  writeDefaultSessionViewState(null)
  mutationRevision = 0
  loadStarted = false
  listeners.clear()
}
