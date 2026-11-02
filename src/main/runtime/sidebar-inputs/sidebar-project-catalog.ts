import type { MobileProjectSectionCatalog } from '../../../shared/mobile-project-sections-contract'
import type { PersistedUIState } from '../../../shared/persisted-ui-state-types'
import {
  buildSidebarProjectCatalog,
  type PairedServerCatalog
} from '../../../shared/sidebar-list/sidebar-project-catalog'
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
    getUI?: () => Pick<
      PersistedUIState,
      'manualRepoOrder' | 'projectOrderBy' | 'personalProjectOrder'
    >
  }

/** This host's store as clients may list it, with its paired servers' catalogs. */
export function readSidebarProjectCatalog(
  store: SidebarProjectCatalogStore,
  servers: readonly PairedServerCatalog[]
): MobileProjectSectionCatalog {
  return buildSidebarProjectCatalog(
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
