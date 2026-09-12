import {
  WorktreeCatalogSnapshotClient,
  WORKTREE_PS_FULL_LIMIT
} from '../worktree/worktree-catalog-snapshot-client'
import type { ConnectionState, RpcResponse } from '../transport/types'
import type { Worktree } from '../worktree/workspace-list-sections'

export const MOBILE_AGENTS_POLL_INTERVAL_MS = 3000
export const MOBILE_AGENTS_WORKTREE_PS_LIMIT = WORKTREE_PS_FULL_LIMIT

export type MobileAgentsCenterState =
  | { kind: 'loading'; message: string }
  | { kind: 'connecting'; message: string }
  | { kind: 'error'; message: string; showReconnect: boolean }
  | { kind: 'empty'; message: string }

export function getMobileAgentsCenterState(args: {
  loaded: boolean
  connectionState: ConnectionState
  isErrorVerdict: boolean
  showConnecting: boolean
  visibleGroupCount: number
  hasActiveFilter: boolean
  error: string | null
  verdictLabel: string
}): MobileAgentsCenterState | null {
  if (!args.loaded && args.error && !args.isErrorVerdict) {
    return { kind: 'error', message: args.error, showReconnect: false }
  }
  if (!args.loaded && args.connectionState === 'connected') {
    return { kind: 'loading', message: 'Loading agents...' }
  }
  if (!args.loaded && args.isErrorVerdict) {
    return {
      kind: 'error',
      message: args.error ?? args.verdictLabel,
      showReconnect: true
    }
  }
  if (!args.loaded && args.showConnecting) {
    return { kind: 'connecting', message: 'Connecting to host...' }
  }
  if (args.visibleGroupCount > 0) {
    return null
  }
  if (args.error) {
    return { kind: 'error', message: args.error, showReconnect: false }
  }
  return {
    kind: 'empty',
    message: args.hasActiveFilter ? 'No agents match these filters.' : 'No agent activity yet.'
  }
}

export type MobileAgentsPsClient = {
  sendRequest: (method: string, params?: unknown) => Promise<RpcResponse>
}

export type MobileAgentsFetchSnapshot = {
  client: MobileAgentsPsClient | null
  connectionState: ConnectionState
  hostId: string
}

export type MobileAgentsFetcherIo = {
  readCurrent: () => MobileAgentsFetchSnapshot
  applyWorktrees: (worktrees: Worktree[]) => void
  applyRequestError: (message: string) => void
  applyTransportError: (message: string) => void
}

// Why: a worktree.ps poll can resolve after the screen has switched to another
// host or transport client. `readCurrent` is re-read after the await, so a
// delayed response captured for a prior host/client is dropped instead of
// overwriting the new host's state.
export function createMobileAgentsFetcher(io: MobileAgentsFetcherIo): () => Promise<void> {
  let inFlight: MobileAgentsFetchSnapshot | null = null
  const catalog = new WorktreeCatalogSnapshotClient()
  return async () => {
    const request = io.readCurrent()
    if (
      !request.client ||
      request.connectionState !== 'connected' ||
      (inFlight?.client === request.client && inFlight?.hostId === request.hostId)
    ) {
      return
    }
    inFlight = request
    try {
      const fetched = await catalog.fetch(request.client, request.hostId)
      const current = io.readCurrent()
      if (current.client !== request.client || current.hostId !== request.hostId) {
        return
      }
      if (fetched.kind === 'request_failed') {
        io.applyRequestError(fetched.code)
      } else if (fetched.pending.admission.kind === 'invalid') {
        io.applyRequestError('Invalid worktree catalog response')
      } else {
        const worktrees = catalog.admit(fetched.pending)
        if (worktrees) {
          io.applyWorktrees(worktrees)
        }
      }
    } catch (error) {
      const current = io.readCurrent()
      if (current.client === request.client && current.hostId === request.hostId) {
        io.applyTransportError(error instanceof Error ? error.message : 'Unable to load agents')
      }
    } finally {
      if (inFlight === request) {
        inFlight = null
      }
    }
  }
}
