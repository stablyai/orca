import type { ExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  indexPersistedPtySurfaceBindings,
  indexPersistedPtyWorktreeBindings
} from './runtime-worktree-binding-index'

type PersistedSessionStore = {
  getWorkspaceSession?: (hostId: ExecutionHostId) => WorkspaceSessionState | null | undefined
}

export function createPersistedPtyIndexesReader(store: PersistedSessionStore | undefined) {
  const indexesByHostId = new Map<
    ExecutionHostId,
    {
      worktreeIdByPtyId: ReadonlyMap<string, string>
      surfaceByPtyId: ReturnType<typeof indexPersistedPtySurfaceBindings>
    }
  >()
  return (hostId: ExecutionHostId) => {
    const existing = indexesByHostId.get(hostId)
    if (existing) {
      return existing
    }
    const persistedSession = store?.getWorkspaceSession?.(hostId)
    const indexes = {
      worktreeIdByPtyId: indexPersistedPtyWorktreeBindings(persistedSession),
      surfaceByPtyId: indexPersistedPtySurfaceBindings(persistedSession)
    }
    indexesByHostId.set(hostId, indexes)
    return indexes
  }
}

export function isCurrentPtyInventoryGeneration(args: {
  connectionId: string | null | undefined
  inventoryGeneration: number
  aggregateGeneration: number
  providerGenerations: ReadonlyMap<string, number>
  providerKey: string
}): boolean {
  const {
    connectionId,
    inventoryGeneration,
    aggregateGeneration,
    providerGenerations,
    providerKey
  } = args
  return connectionId === undefined
    ? aggregateGeneration === inventoryGeneration &&
        ![...providerGenerations.values()].some((generation) => generation > inventoryGeneration)
    : providerGenerations.get(providerKey) === inventoryGeneration &&
        aggregateGeneration <= inventoryGeneration
}

export function buildPtyInventoryListOptions(args: {
  listBudgetMs: number
  providerMarginMs: number
  inventoryOptions?: {
    includeForegroundProcessEvidence?: boolean
    signal?: AbortSignal
  }
}): { deadlineMs: number; includeForegroundProcessEvidence?: boolean; signal?: AbortSignal } {
  const { listBudgetMs, providerMarginMs, inventoryOptions } = args
  return {
    deadlineMs: Date.now() + Math.max(1, listBudgetMs - providerMarginMs),
    ...(inventoryOptions?.includeForegroundProcessEvidence === undefined
      ? {}
      : { includeForegroundProcessEvidence: inventoryOptions.includeForegroundProcessEvidence }),
    ...(inventoryOptions?.signal ? { signal: inventoryOptions.signal } : {})
  }
}
