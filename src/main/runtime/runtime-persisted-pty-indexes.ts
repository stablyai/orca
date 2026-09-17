import type { ExecutionHostId } from '../../shared/execution-host'
import type { RuntimeStore } from './runtime-store-contract'
import {
  indexPersistedPtySurfaceBindings,
  indexPersistedPtyWorktreeBindings
} from './runtime-worktree-binding-index'

export type RuntimePersistedPtyIndexes = {
  worktreeIdByPtyId: ReadonlyMap<string, string>
  surfaceByPtyId: ReturnType<typeof indexPersistedPtySurfaceBindings>
}

export function getPersistedPtyIndexes(args: {
  cache: Map<ExecutionHostId, RuntimePersistedPtyIndexes>
  store: RuntimeStore | null
  hostId: ExecutionHostId
}): RuntimePersistedPtyIndexes {
  const existing = args.cache.get(args.hostId)
  if (existing) {
    return existing
  }
  const persistedSession = args.store?.getWorkspaceSession?.(args.hostId)
  const indexes = {
    worktreeIdByPtyId: indexPersistedPtyWorktreeBindings(persistedSession),
    surfaceByPtyId: indexPersistedPtySurfaceBindings(persistedSession)
  }
  args.cache.set(args.hostId, indexes)
  return indexes
}
