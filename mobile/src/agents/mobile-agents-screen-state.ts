import type { ConnectionState, RpcResponse } from '../transport/types'
import type { Worktree } from '../worktree/workspace-list-sections'

export const MOBILE_AGENTS_POLL_INTERVAL_MS = 3000
export const MOBILE_AGENTS_WORKTREE_PS_LIMIT = 10000

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
  isLoaded: () => boolean
  applyWorktrees: (worktrees: Worktree[]) => void
  applyRequestError: (message: string) => void
  applyTransportError: (message: string) => void
}

// Why: a worktree.ps poll can resolve after the screen has switched to another
// host or transport client. `readCurrent` is re-read after the await, so a
// delayed response captured for a prior host/client is dropped instead of
// overwriting the new host's state.
export function createMobileAgentsFetcher(io: MobileAgentsFetcherIo): () => Promise<void> {
  let inFlight = false
  return async () => {
    const request = io.readCurrent()
    if (!request.client || request.connectionState !== 'connected' || inFlight) {
      return
    }
    inFlight = true
    try {
      const response = await request.client.sendRequest('worktree.ps', {
        limit: MOBILE_AGENTS_WORKTREE_PS_LIMIT
      })
      const current = io.readCurrent()
      if (current.client !== request.client || current.hostId !== request.hostId) {
        return
      }
      if (response.ok) {
        // Why: mobile trusts the authenticated host's worktree.ps shape, matching
        // the existing consumers in app/index.tsx and the host index screen.
        const result = response.result as { worktrees: Worktree[] }
        io.applyWorktrees(result.worktrees)
      } else {
        io.applyRequestError(response.error.message)
      }
    } catch (error) {
      if (!io.isLoaded()) {
        io.applyTransportError(error instanceof Error ? error.message : 'Unable to load agents')
      }
    } finally {
      inFlight = false
    }
  }
}
