// Layout-owner build only: main drops the stored layout of workspaces the catalog no longer
// validates, by the same rule the window applies when it hydrates, so neither keeps what the other dropped.

import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { isWorktreeCatalogVersionBefore } from '../../../shared/worktree/catalog-version'
import {
  buildValidWorktreeIdsForSessionHydration,
  collectPersistedWorktreeIdsForSessionHydration
} from '../../../shared/worktree/degraded-repo-worktree-validity'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import {
  hostWorktreeTarget,
  type HostWorktreeTarget
} from '../../../shared/worktree/host-qualified-identity'
import type { DetectedWorktreeListResult } from '../../../shared/worktree/types'
import { getLocalWorktreeCatalogVersion } from '../../local-worktree-scan-generation'

type WorkspaceValidityCatalog = Parameters<typeof buildValidWorktreeIdsForSessionHydration>[0]

type PurgeStore = {
  getRepos(): readonly { id: string }[]
  getWorkspaceSession(hostId?: string | null): WorkspaceSessionState
  getWorkspaceSessionHostIds(): ExecutionHostId[]
  removeWorkspaceSessionStateForWorktree(target: HostWorktreeTarget): void
}

const ownedByPairedHost = (hostId: string | null | undefined): boolean =>
  parseExecutionHostId(hostId)?.kind === 'runtime'

/** The window's hydration rule: floating and every folder key always stay (the window adds them). */
function invalidWorkspaceKeys(
  session: WorkspaceSessionState,
  catalog: WorkspaceValidityCatalog,
  inScope: (key: string) => boolean
): string[] {
  const persisted = [...collectPersistedWorktreeIdsForSessionHydration(session)].filter(
    (key) =>
      inScope(key) &&
      key !== FLOATING_TERMINAL_WORKTREE_ID &&
      parseWorkspaceKey(key)?.type !== 'folder'
  )
  const valid = buildValidWorktreeIdsForSessionHydration(catalog, persisted)
  return persisted.filter((key) => !valid.has(key))
}

function dropInvalidWorkspaces(
  store: PurgeStore,
  catalog: WorkspaceValidityCatalog,
  inScope: (key: string) => boolean = () => true
): void {
  for (const hostId of store.getWorkspaceSessionHostIds()) {
    // A paired host's catalog lives on that host; not seeing it here proves nothing.
    if (ownedByPairedHost(hostId)) {
      continue
    }
    for (const key of invalidWorkspaceKeys(store.getWorkspaceSession(hostId), catalog, inScope)) {
      store.removeWorkspaceSessionStateForWorktree(hostWorktreeTarget({ id: key, hostId }))
    }
  }
}

/**
 * At load no listing has run, so only an unregistered repo is invalid. Repos a paired host still
 * names, and a staged migration's repos, count as registered, exactly as the load sweep keeps them.
 */
export function dropInvalidWorkspaceLayoutsAtLoad(store: PurgeStore, state: PersistedState): void {
  const repoIds = new Set(store.getRepos().map((repo) => repo.id))
  for (const staged of state.orcadMigrationStagedCatalogs ?? []) {
    for (const repo of staged.manifest.payload.repositories) {
      repoIds.add(repo.id)
    }
  }
  for (const [worktreeId, meta] of Object.entries(state.worktreeMeta)) {
    if (ownedByPairedHost(meta.hostId)) {
      repoIds.add(getRepoIdFromWorktreeId(worktreeId))
    }
  }
  for (const [hostId, session] of Object.entries(state.workspaceSessionsByHostId ?? {})) {
    if (session && ownedByPairedHost(hostId)) {
      for (const key of collectPersistedWorktreeIdsForSessionHydration(session)) {
        repoIds.add(getRepoIdFromWorktreeId(key))
      }
    }
  }
  dropInvalidWorkspaces(store, {
    repos: [...repoIds].map((id) => ({ id })),
    worktreesByRepo: {}
  })
}

/**
 * After a listing main serves: drops that repo's workspaces an authoritative scan no longer finds.
 * Hidden rows still count as found: hiding a worktree must not close its tabs.
 */
export function dropWorkspacesTheListingInvalidates(
  store: PurgeStore,
  result: DetectedWorktreeListResult | { providerAbortStatus: unknown } | null
): void {
  if (!result || 'providerAbortStatus' in result) {
    return
  }
  const { repoId, catalogVersion } = result
  // A create or remove since the scan began leaves its rows short of live worktrees.
  if (
    !catalogVersion ||
    isWorktreeCatalogVersionBefore(catalogVersion, getLocalWorktreeCatalogVersion(repoId))
  ) {
    return
  }
  // A repo id registered on two hosts shares its keys; one host's scan cannot speak for the other.
  if (store.getRepos().filter((repo) => repo.id === repoId).length !== 1) {
    return
  }
  dropInvalidWorkspaces(
    store,
    {
      repos: store.getRepos(),
      worktreesByRepo: { [repoId]: result.worktrees },
      detectedWorktreesByRepo: { [repoId]: result }
    },
    (key) => getRepoIdFromWorktreeId(key) === repoId
  )
}
