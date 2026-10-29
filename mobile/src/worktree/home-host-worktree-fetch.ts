import { setCachedWorktrees } from '../cache/worktree-cache'
import type { RpcClient } from '../transport/rpc-client'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import {
  markHomeWorktreeCatalogUnavailable,
  type HomeWorktreeSummary,
  type HostWorktreeInfo
} from './home-worktree-info'
import { pickResumeWorktree } from './resume-worktree'
import { isWorktreeActive } from './workspace-list-sections'
import { worktreeCatalogRead } from './worktree-catalog-operations'
import { WORKTREE_PS_FULL_LIMIT } from './worktree-catalog-snapshot-client'

// Cutover may stay connected, so retry reads without waiting for the connect gate; cap migration-loop retries.
const CUTOVER_RETRY_LIMIT = 2

export type HostWorktreeInfoSetter = (
  updater: (prev: Record<string, HostWorktreeInfo>) => Record<string, HostWorktreeInfo>
) => void

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
    worktreeCatalogRead
      .requestSingleFlight(client, hostId, { limit: WORKTREE_PS_FULL_LIMIT })
      .then((reply) => {
        if (disposed()) {
          return
        }
        const catalog = worktreeCatalogRead.interpret(reply)
        if (!catalog.accepted) {
          markUnavailable()
          return
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `worktrees` is a salvaged member, so the `?? []` is what makes it an array; the rows stay opaque because three screens project a row differently. This card reads `status` and the resume pick, both through their own guards, and the `worktree-home-catalog` golden records the row it is given as `{worktreeId, displayName, repo, status}`.
        const worktrees = (catalog.value.worktrees ?? []) as HomeWorktreeSummary[]
        setCachedWorktrees(hostId, worktrees, { proven: true })
        // Count what the list shows: archived rows are hidden, and active is the sleeping filter's rule.
        const listed = worktrees.filter((w) => w.isArchived !== true)
        // Mirror the desktop's focused workspace (see pickResumeWorktree).
        const lastActive = pickResumeWorktree(worktrees)
        setInfo((prev) => ({
          ...prev,
          [hostId]: {
            hostId,
            totalWorktrees: listed.length,
            activeCount: listed.filter(isWorktreeActive).length,
            lastActiveWorktree: lastActive,
            countsProvenAt: Date.now()
          }
        }))
      })
      .catch((error: unknown) => {
        if (disposed()) {
          return
        }
        // Cutover authenticated a replacement; ask again rather than treating interruption as an answered refresh.
        if (cutoverRetriesLeft > 0 && isLogicalClientCutoverError(error)) {
          return attempt(cutoverRetriesLeft - 1)
        }
        // Other failures preserve proven counts rather than asserting an empty host.
        markUnavailable()
      })

  return attempt(CUTOVER_RETRY_LIMIT)
}
