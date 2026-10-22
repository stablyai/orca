import type { MobileProjectSectionCatalog } from '../../../shared/mobile-project-sections-contract'
import type { PersistedUIState } from '../../../shared/persisted-ui-state-types'
import {
  buildSidebarProjectCatalogRecords,
  projectSectionCatalogOf,
  type PairedServerCatalog,
  type SidebarProjectCatalogRecords
} from '../../../shared/sidebar-list/sidebar-project-catalog'
import type { Repo } from '../../../shared/repo-types'
import type { RuntimeStore } from '../runtime-store-contract'
import {
  runtimeVisibleProjectGroups,
  runtimeVisibleProjectHostSetups,
  runtimeVisibleRepos
} from '../runtime-visible-catalog'

export type SidebarProjectCatalogStore = Pick<
  RuntimeStore,
  'getRepos' | 'getProjectGroups' | 'getFolderWorkspaces' | 'getSshTargets' | 'getProjectHostSetups'
> &
  Partial<Pick<RuntimeStore, 'getProjects'>> & {
    getUI?: () => Pick<PersistedUIState, 'manualRepoOrder' | 'projectOrderBy'>
  }

function readRecords(
  store: SidebarProjectCatalogStore,
  servers: readonly PairedServerCatalog[]
): SidebarProjectCatalogRecords {
  return buildSidebarProjectCatalogRecords(
    {
      repos: runtimeVisibleRepos(store),
      projectGroups: runtimeVisibleProjectGroups(store),
      projects: store.getProjects?.() ?? [],
      setups: runtimeVisibleProjectHostSetups(store)
    },
    servers,
    store.getUI?.()
  )
}

/** This host's store as clients may list it, with its paired servers' catalogs. */
export function readSidebarProjectCatalog(
  store: SidebarProjectCatalogStore,
  servers: readonly PairedServerCatalog[]
): MobileProjectSectionCatalog {
  return projectSectionCatalogOf(readRecords(store, servers), store.getUI?.())
}

// Why not uploaded icons: a data URL can be hundreds of KB per repo on every read; a reader
// fetches the image through sidebarInputs.repoIcons by the repoIcons domain's id.
function withoutUploadedIcon(repo: Repo): Repo {
  return repo.repoIcon?.type === 'image' && repo.repoIcon.src.startsWith('data:')
    ? { ...repo, repoIcon: null }
    : repo
}

/** The full catalog rows the desktop window holds, from main's one copy. */
export function readSidebarCatalogRecords(
  store: SidebarProjectCatalogStore,
  servers: readonly PairedServerCatalog[]
): SidebarProjectCatalogRecords {
  const records = readRecords(store, servers)
  return { ...records, repos: records.repos.map(withoutUploadedIcon) }
}
