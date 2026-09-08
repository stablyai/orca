import type { StateStorage } from 'zustand/middleware'
import { runtimeClientState, type ClientStateKind } from '../runtime/runtime-client-state-client'
import type { PersistenceStatus } from './slices/persistence-status'

type PersistenceStatusSetter = (
  kind: ClientStateKind,
  status: PersistenceStatus,
  error?: string
) => void

// Why: same reason as runtime-client-state-client.ts's settings accessor —
// this module is (via FE-TASK-STORAGE-005) imported by store/slices/
// keybindings.ts, which store/index.ts imports directly, so a top-level
// `import { useAppStore } from './index'` here would close a circular module
// dependency at evaluation time. store/index.ts calls
// registerPersistenceStatusSetter(...) once, after the store is built.
let setPersistenceStatus: PersistenceStatusSetter = () => {}

export function registerPersistenceStatusSetter(setter: PersistenceStatusSetter): void {
  setPersistenceStatus = setter
}

const RETRY_DELAYS_MS = [2_000, 4_000, 8_000]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Why: retries 3 times (2s/4s/8s backoff) and always resolves — the `persist`
// middleware has no meaningful way to surface an async setItem rejection to
// the caller, so a permanent failure is recorded in persistenceStatus (for
// PersistenceStatusBanner, FE-TASK-STORAGE-005) instead of being thrown.
export async function withRetryAndErrorStatus(
  kind: ClientStateKind,
  write: () => Promise<void>
): Promise<void> {
  setPersistenceStatus(kind, 'pending')
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      await write()
      setPersistenceStatus(kind, 'synced')
      return
    } catch (err) {
      if (attempt === RETRY_DELAYS_MS.length) {
        setPersistenceStatus(kind, 'error', err instanceof Error ? err.message : String(err))
        return
      }
      await sleep(RETRY_DELAYS_MS[attempt])
    }
  }
}

// Why: mirrors the enqueuePersist pattern in slices/diffComments.ts — the
// `persist` middleware does not serialize concurrent setItem calls, so a
// state change that lands while a retry is still in flight could otherwise
// fire a second write in parallel and land out of order. Only the latest
// queued write's outcome matters; each new call just chains onto the tail.
const pendingByKind = new Map<ClientStateKind, Promise<void>>()

export function enqueueWrite(kind: ClientStateKind, write: () => Promise<void>): Promise<void> {
  const run = async (): Promise<void> => {
    await write()
  }
  const prior = pendingByKind.get(kind) ?? Promise.resolve()
  const chained = prior.then(run, run)
  pendingByKind.set(kind, chained)
  const cleanup = (): void => {
    if (pendingByKind.get(kind) === chained) {
      pendingByKind.delete(kind)
    }
  }
  chained.then(cleanup, cleanup)
  return chained
}

// FE-TASK-STORAGE-004 (CR-STORAGE-002): a Zustand `persist` StateStorage
// backed by runtimeClientState (backend-go), not localStorage — see
// FE-SOL-STORAGE-002 §1. `name` (the persist store key) is unused: `kind`
// already identifies the backend-go column, and it never maps to a
// localStorage key here.
export function createBackendGoStorage(kind: ClientStateKind): StateStorage {
  return {
    getItem: async (_name) => {
      const value = await runtimeClientState.get<unknown>(kind)
      return value === null ? null : JSON.stringify(value)
    },
    setItem: async (_name, value) => {
      await enqueueWrite(kind, () =>
        withRetryAndErrorStatus(kind, () => runtimeClientState.set(kind, JSON.parse(value)))
      )
    },
    removeItem: async (_name) => {
      await runtimeClientState.set(kind, null)
    }
  }
}
