import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { ClientStateKind } from '../../runtime/runtime-client-state-client'

export type PersistenceStatus = 'synced' | 'pending' | 'error'

export type PersistenceStatusEntry = {
  status: PersistenceStatus
  lastError?: string
}

// FE-TASK-STORAGE-004 (CR-STORAGE-002): backend-go-storage.ts's
// withRetryAndErrorStatus writes here so any UI (PersistenceStatusBanner,
// FE-TASK-STORAGE-005) can show "this kind failed to save" instead of the
// prior silent-swallow behavior (web-preload-api.ts's ui.set failure path).
export type PersistenceStatusSlice = {
  persistenceStatus: Partial<Record<ClientStateKind, PersistenceStatusEntry>>
  setPersistenceStatus: (kind: ClientStateKind, status: PersistenceStatus, error?: string) => void
}

export const createPersistenceStatusSlice: StateCreator<
  AppState,
  [],
  [],
  PersistenceStatusSlice
> = (set) => ({
  persistenceStatus: {},
  setPersistenceStatus: (kind, status, error) =>
    set((state) => ({
      persistenceStatus: {
        ...state.persistenceStatus,
        [kind]: { status, ...(error !== undefined ? { lastError: error } : {}) }
      }
    }))
})
