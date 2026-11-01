import { setCachedWorktrees } from '../cache/worktree-cache'
import type { RpcClient } from '../transport/rpc-client'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import {
  markHomeWorktreeCatalogUnavailable,
  type HomeWorktreeSummary,
  type HostWorktreeInfo
} from './home-worktree-info'
import { selectHomeAttentionWorktrees } from './home-jump-back-in'
import { pickResumeWorktree } from './resume-worktree'
import { isWorktreeActive } from './workspace-list-sections'
import { WorktreeCatalogSnapshotClient } from './worktree-catalog-snapshot-client'

// Cutover may stay connected, so retry reads without waiting for the connect gate; cap migration-loop retries.
const CUTOVER_RETRY_LIMIT = 2

type HomeCatalogState = {
  snapshots: WorktreeCatalogSnapshotClient
  inFlight: Promise<unknown[] | null> | null
  trailing: Promise<unknown[] | null> | null
}

const homeCatalogs = new WeakMap<RpcClient, Map<string, HomeCatalogState>>()

function homeCatalogState(client: RpcClient, hostId: string): HomeCatalogState {
  let byHost = homeCatalogs.get(client)
  if (!byHost) {
    byHost = new Map()
    homeCatalogs.set(client, byHost)
  }
  let state = byHost.get(hostId)
  if (!state) {
    state = {
      snapshots: new WorktreeCatalogSnapshotClient({ exactActivity: true }),
      inFlight: null,
      trailing: null
    }
    byHost.set(hostId, state)
  }
  return state
}

// Null when the host refused the catalog; a reply that cannot rebuild from our base is re-read in full once.
async function readHomeCatalogOnce(
  state: HomeCatalogState,
  client: RpcClient,
  hostId: string
): Promise<unknown[] | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const fetched = await state.snapshots.fetch(client, hostId)
    if (fetched.kind === 'request_failed') {
      return null
    }
    const rows = state.snapshots.admit(fetched.pending)
    if (rows) {
      return rows
    }
  }
  return null
}

function startHomeCatalogRead(
  state: HomeCatalogState,
  client: RpcClient,
  hostId: string
): Promise<unknown[] | null> {
  const read = readHomeCatalogOnce(state, client, hostId).finally(() => {
    state.inFlight = null
  })
  state.inFlight = read
  return read
}

// One read per host at a time: concurrent reads from one base snapshot would discard each other's delta.
// A refresh asked mid-flight joins one trailing read, so it never settles with rows older than its ask.
function readHomeCatalog(client: RpcClient, hostId: string): Promise<unknown[] | null> {
  const state = homeCatalogState(client, hostId)
  if (!state.inFlight) {
    return startHomeCatalogRead(state, client, hostId)
  }
  const settled = () => {
    state.trailing = null
    return startHomeCatalogRead(state, client, hostId)
  }
  state.trailing ??= state.inFlight.then(settled, settled)
  return state.trailing
}

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
    readHomeCatalog(client, hostId)
      .then((rows) => {
        if (disposed()) {
          return
        }
        if (!rows) {
          markUnavailable()
          return
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rows stay opaque because three screens project a row differently. Home reads `status`, `sidebarStatus` and the resume pick, both through their own guards, and the `worktree-home-catalog` golden records the row it is given as `{worktreeId, displayName, repo, status}`.
        const worktrees = rows as HomeWorktreeSummary[]
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
            attention: selectHomeAttentionWorktrees(listed),
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
