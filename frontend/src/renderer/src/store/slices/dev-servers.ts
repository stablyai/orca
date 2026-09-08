import type { StateCreator } from 'zustand'
import type { DevServer } from '../../../../shared/dev-server-types'
import type { AppState } from '../types'
import { callRuntimeRpc, type RuntimeClientTarget } from '../../runtime/runtime-rpc-client'

// ─── Slice Type ───────────────────────────────────────────────────────────────

export type DevServerSlice = {
  devServers: DevServer[]
  activeDevServerId: string | null

  setDevServers: (servers: DevServer[]) => void
  upsertDevServer: (server: DevServer) => void
  removeDevServer: (id: string) => void
  setActiveDevServerId: (id: string | null) => void
  updateDevServerStatus: (
    id: string,
    status: DevServer['status'],
    extra?: Partial<
      Pick<DevServer, 'platform' | 'arch' | 'nodeVersion' | 'lastConnectedAt' | 'lastError'>
    >
  ) => void
  /** Hydrates `devServers` from `devServer.listForUser` (CR-STORAGE-006's
   *  hydrate-on-mount pattern, FE-TASK-STORAGE-012) — an existing, real RPC
   *  (see BE-SOL-STORAGE-002's audit appendix), scoped to dev servers the
   *  caller's department/team was granted access to. Additive: useDevServersSync
   *  already loads the unscoped `devServer.list` on mount and keeps doing so
   *  unchanged (see its own doc comment); this gives the slice its own
   *  testable hydrate entry point, matching FE-TASK-STORAGE-013's pattern for
   *  ssh.ts/runtime-environment-ssh.ts, not a replacement wiring.
   *
   *  Known caveat (BUG-013, not fixed here — out of scope): `devServer.
   *  listForUser`'s team-membership grants were confirmed still ignored by
   *  BE-SOL-STORAGE-002's audit as of TASK-BE-STORAGE-005 (team_ids
   *  resolution depends on a separate in-flight backend-go fix) — a user
   *  granted access only via a team, not directly or via department, may see
   *  an incomplete list from this hydrate today.
   *
   *  Swallows RPC failures silently (no `devServers` write, no crash) — the
   *  slice has no existing "hydrate sync status" field to report into (only
   *  `persistenceStatus`, which tracks client-state *write* failures, an
   *  unrelated concept); do not invent one here per this task's scope.
   */
  hydrateDevServers: (target: RuntimeClientTarget) => Promise<void>
}

// ─── Slice Implementation ─────────────────────────────────────────────────────
// Why: this file deliberately holds ONLY the slice, no useAppStore-reading
// hooks — store/index.ts imports createDevServerSlice from here directly to
// build the aggregate store, and a hook needing a top-level `import {
// useAppStore } from '../index'` living in the SAME file would make that a
// genuine circular module dependency (see dev-servers-selectors.ts's own
// doc comment, where those hooks now live, for the live bug this caused).

export const createDevServerSlice: StateCreator<AppState, [], [], DevServerSlice> = (set) => ({
  devServers: [],
  activeDevServerId: null,

  setDevServers: (servers) => set({ devServers: servers }),

  upsertDevServer: (server) =>
    set((state) => ({
      devServers: state.devServers.some((ds) => ds.id === server.id)
        ? state.devServers.map((ds) => (ds.id === server.id ? { ...ds, ...server } : ds))
        : [...state.devServers, server]
    })),

  removeDevServer: (id) =>
    set((state) => ({
      devServers: state.devServers.filter((ds) => ds.id !== id),
      activeDevServerId: state.activeDevServerId === id ? null : state.activeDevServerId
    })),

  setActiveDevServerId: (id) => set({ activeDevServerId: id }),

  updateDevServerStatus: (id, status, extra = {}) =>
    set((state) => ({
      devServers: state.devServers.map((ds) => (ds.id === id ? { ...ds, status, ...extra } : ds))
    })),

  hydrateDevServers: async (target) => {
    try {
      const { devServers } = await callRuntimeRpc<{ devServers: DevServer[] }>(
        target,
        'devServer.listForUser',
        {}
      )
      set({ devServers })
    } catch {
      // Why: a failed/unreachable hydrate must not crash the caller or wipe
      // out a devServers list a prior successful load/status-push already
      // populated — see this action's doc comment for the BUG-013 caveat.
    }
  }
})
