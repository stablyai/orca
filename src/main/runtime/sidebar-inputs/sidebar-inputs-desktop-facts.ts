import {
  getRegisteredSshState,
  listRegisteredSshTargets
} from '../../ssh/targets/ssh-target-registry'
import { getWslHostService } from '../../wsl/host-lifecycle/wsl-host-service-instance'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import type { DesktopSidebarFacts } from '../../../shared/sidebar-list/feed-facts/desktop-sidebar-facts'
import type { RuntimeStore } from '../construction/runtime-store-contract'
import { WORKTREE_METADATA_DOMAINS } from '../../persistence/profile-save-domains'
import type { PersistedUIState } from '../../../shared/persisted-ui-state-types'
import { readDesktopSidebarFacts } from './catalog/desktop-sidebar-facts'

/** This host's store and connection registries, read the way sidebarInputs.desktopFacts reads them. */
export function readRuntimeDesktopSidebarFacts(
  store: RuntimeStore,
  installationId: string | undefined
): DesktopSidebarFacts {
  return readDesktopSidebarFacts({
    store,
    sshTargets: listRegisteredSshTargets(),
    sshStateOf: getRegisteredSshState,
    wslStatuses: getWslHostService()?.getStatuses() ?? [],
    installationId
  })
}

// The bus every catalog, view and SSH change reaches clients through.
export const CATALOG_EVENTS = new Set<RuntimeClientEvent['type']>([
  'worktreesChanged',
  'reposChanged',
  'workspaceViewChanged',
  'sshStateChanged'
])

// The host's sidebar view settings, each its own entity; ui.get serves the same fields.
export const SIDEBAR_VIEW_UI_FIELDS = [
  'groupBy',
  'sortBy',
  'projectOrderBy',
  'hideSleepingWorkspaces',
  'hideDefaultBranchWorkspace',
  'alwaysShowDefaultBranchWorkspace',
  'hideAutomationGeneratedWorkspaces',
  'hideCliCreatedWorkspaces',
  'hideDetachedHeadWorkspaces',
  'hideWorkspacesFromOtherDevices',
  'filterRepoIds',
  'collapsedGroups',
  'workspaceStatuses',
  'workspaceHostScope',
  'visibleWorkspaceHostIds',
  'worktreeCardProperties',
  'agentActivityDisplayMode'
] as const satisfies readonly (keyof PersistedUIState)[]

export const DESKTOP_WRITE_DOMAINS = [...WORKTREE_METADATA_DOMAINS, 'settings', 'ui']
