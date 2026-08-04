import { setCachedWorktrees } from '../cache/worktree-cache'
import { sendSingleFlightRequest } from '../transport/request-single-flight'
import type { RpcClient } from '../transport/rpc-client'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import {
  markHomeWorktreeCatalogUnavailable,
  type HomeWorktreeSummary,
  type HostWorktreeInfo
} from './home-worktree-info'
import { pickResumeWorktree } from './resume-worktree'
import { WORKTREE_PS_FULL_LIMIT } from './worktree-catalog-snapshot-client'

const ACTIVE_STATUSES = new Set(['working', 'active', 'permission'])
// Why: a relay↔direct cutover rejects in-flight reads without ever leaving 'connected', so the
// connect gate never re-arms. Re-issue on the replacement session; cap it so a migration loop
// can't spin. See runtime-capability-probe.ts for the same hazard on status.get.
const CUTOVER_RETRY_LIMIT = 2

export type HostWorktreeInfoSetter = (
  updater: (prev: Record<string, HostWorktreeInfo>) => Record<string, HostWorktreeInfo>
) => void

/** Reads one host's worktree catalog for the Home card, preserving proven counts on failure. */
export function fetchHomeHostWorktreeInfo(
  client: RpcClient,
  hostId: string,
  setInfo: HostWorktreeInfoSetter,
  disposed: () => boolean
): Promise<void> {
  const markUnavailable = (): void => {
    setInfo((prev) => {
      const current = prev[hostId]
      const next = markHomeWorktreeCatalogUnavailable(current, hostId)
      return next === current ? prev : { ...prev, [hostId]: next }
    })
  }

  const attempt = (cutoverRetriesLeft: number): Promise<void> =>
    sendSingleFlightRequest(client, hostId, 'worktree.ps', { limit: WORKTREE_PS_FULL_LIMIT })
      .then((response) => {
        if (disposed()) {
          return
        }
        if (!response.ok) {
          markUnavailable()
          return
        }
        const result = response.result as { worktrees?: HomeWorktreeSummary[] }
        const worktrees = result.worktrees ?? []
        setCachedWorktrees(hostId, worktrees)
        const active = worktrees.filter((w) => w.status && ACTIVE_STATUSES.has(w.status))
        // Mirror the desktop's focused workspace (see pickResumeWorktree).
        const lastActive = pickResumeWorktree(worktrees)
        setInfo((prev) => ({
          ...prev,
          [hostId]: {
            hostId,
            totalWorktrees: worktrees.length,
            activeCount: active.length,
            lastActiveWorktree: lastActive,
            countsProvenAt: Date.now()
          }
        }))
      })
      .catch((error: unknown) => {
        if (disposed()) {
          return
        }
        // A cutover raises only after migrateTo installed an authenticated replacement, so the
        // read was interrupted, not answered — ask again instead of latching "Last known".
        if (cutoverRetriesLeft > 0 && isLogicalClientCutoverError(error)) {
          return attempt(cutoverRetriesLeft - 1)
        }
        // Any other rejection (socket died mid-request) is a failed refresh, not an empty host.
        markUnavailable()
      })

  return attempt(CUTOVER_RETRY_LIMIT)
}
