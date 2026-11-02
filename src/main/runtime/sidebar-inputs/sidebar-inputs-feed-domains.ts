import {
  getRegisteredSshState,
  listRegisteredSshTargets
} from '../../ssh/targets/ssh-target-registry'
import { getWslHostService } from '../../wsl/wsl-host-service-instance'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import type { DesktopSidebarFacts } from '../../../shared/sidebar-list/desktop-sidebar-facts'
import type { RuntimeStore } from '../runtime-store-contract'
import { WORKTREE_METADATA_DOMAINS } from '../../persistence/loading-store/worktree-identity-metadata'
import type { PersistedUIState } from '../../../shared/persisted-ui-state-types'
import type { OrcaRuntimeWithSidebarTemporal } from './orca-runtime-sidebar-temporal'
import type { PairedServerRowsProducer } from './paired-server-rows-producer'
import type { WorkspaceLifecycleQueue } from '../workspaces/workspace-lifecycle-queue'
import type { WorkspaceRowsProducer } from './workspace-rows-producer'
import type { RepoIconDataUrls } from './repo-icon-data-urls'
import type { SidebarInputsFeedDomain } from './sidebar-inputs-feed'
import { readDesktopSidebarFacts } from './desktop-sidebar-facts'
import { readSidebarProjectCatalog } from './sidebar-project-catalog'
import {
  buildPairedServerReviewFacts,
  buildWorkspaceReviewFacts
} from '../../../shared/sidebar-list/workspace-review-facts'
import { buildPairedServerActivityFacts } from '../../../shared/sidebar-list/paired-server-activity-facts'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { keyWorkspaceActivityByRow } from '../../../shared/sidebar-list/workspace-activity-facts'

/** This host's store and connection registries, read the way sidebarInputs.desktopFacts reads them. */
export function readRuntimeDesktopSidebarFacts(store: RuntimeStore): DesktopSidebarFacts {
  return readDesktopSidebarFacts({
    store,
    sshTargets: listRegisteredSshTargets(),
    sshStateOf: getRegisteredSshState,
    wslStatuses: getWslHostService()?.getStatuses() ?? []
  })
}

// The bus every catalog, view and SSH change reaches clients through.
const CATALOG_EVENTS = new Set<RuntimeClientEvent['type']>([
  'worktreesChanged',
  'reposChanged',
  'workspaceViewChanged',
  'sshStateChanged'
])

// The host's sidebar view settings, each its own entity; ui.get serves the same fields.
const SIDEBAR_VIEW_UI_FIELDS = [
  'groupBy',
  'sortBy',
  'projectOrderBy',
  'personalProjectOrder',
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

const DESKTOP_WRITE_DOMAINS = [...WORKTREE_METADATA_DOMAINS, 'settings', 'ui']

export type SidebarInputsFeedSources = {
  facts: OrcaRuntimeWithSidebarTemporal
  pairedServerRows: PairedServerRowsProducer
  workspaceLifecycle: WorkspaceLifecycleQueue
  workspaceRows: WorkspaceRowsProducer
  repoIcons: Pick<RepoIconDataUrls, 'idsByRepo'>
  store: () => RuntimeStore | null
  onClientEvent: (
    listener: (event: RuntimeClientEvent) => void,
    options: { consumesTerminalSideEffects: false }
  ) => () => void
}

/** Every merged producer's snapshot, keyed per entity: a change re-sends only what it touched. */
export function sidebarInputsFeedDomains(
  sources: SidebarInputsFeedSources
): SidebarInputsFeedDomain[] {
  const { facts, pairedServerRows, workspaceLifecycle, workspaceRows } = sources
  const urgent = { urgent: true }
  const watchCatalog = (changed: () => void): (() => void) =>
    sources.onClientEvent(
      (event) => {
        if (CATALOG_EVENTS.has(event.type)) {
          changed()
        }
      },
      { consumesTerminalSideEffects: false }
    )
  const requireStore = (): RuntimeStore => {
    const store = sources.store()
    if (!store) {
      throw new Error('no store')
    }
    return store
  }
  return [
    {
      name: 'activity',
      read: () => {
        const rows = workspaceRows.snapshot()?.rows
        if (!rows) {
          return null
        }
        return {
          // This host's session tabs and agents are by bare id, so a same-id pair it lists share them.
          ...keyWorkspaceActivityByRow(facts.getWorkspaceActivityFacts().facts, rows),
          ...buildPairedServerActivityFacts(
            pairedServerRows.snapshot().servers,
            (hostId) => sources.store()?.getWorkspaceSession?.(hostId) ?? null
          )
        }
      },
      ready: () => workspaceRows.ready(),
      watch: (changed) => {
        const detaches = [
          facts.workspaceActivityFacts.revision.onChange(changed),
          workspaceRows.revision.onChange(changed),
          pairedServerRows.revision.onChange(changed),
          // This desktop's saved session for a paired server holds its browser and chat tabs there.
          sources.store()?.onWorkspaceSessionWritten?.((hostId) => {
            if (hostId === null || parseExecutionHostId(hostId)?.kind === 'runtime') {
              changed()
            }
          })
        ]
        return () => detaches.forEach((detach) => detach?.())
      }
    },
    {
      name: 'temporal',
      read: () => {
        const { sessionId, retention } = facts.getSidebarTemporalSnapshot()
        return { sessionId, retention }
      },
      watch: (changed) => facts.onSidebarTemporalChange(changed)
    },
    {
      // The queue's creates, as the creations readers read them.
      name: 'creations',
      read: () => workspaceLifecycle.creationsSnapshot().creations,
      // An accepted command shows at once.
      watch: (changed) => workspaceLifecycle.revision.onChange(() => changed(urgent))
    },
    {
      // Each workspace's running, waiting or paused lifecycle command, keyed host-qualified.
      name: 'inProgress',
      read: () => workspaceLifecycle.hints(),
      watch: (changed) => workspaceLifecycle.revision.onChange(() => changed(urgent))
    },
    {
      name: 'workspaces',
      read: () => workspaceRows.snapshot()?.rows ?? null,
      watch: (changed) => workspaceRows.revision.onChange(changed),
      ready: () => workspaceRows.ready()
    },
    {
      // The imported card and new-external inbox inputs; no reader yet.
      name: 'detected',
      read: () => facts.detectedCheckouts.snapshot(),
      // No ready: a phone's first read never waits on every repo's listing.
      watch: (changed) => facts.detectedCheckouts.watch(() => changed())
    },
    {
      // Live terminal content per workspace; no reader yet.
      name: 'liveContent',
      read: () => facts.workspaceLiveContent.snapshot(),
      watch: (changed) => facts.workspaceLiveContent.revision.onChange(changed)
    },
    {
      // The sidebar view settings; no reader yet (each still reads ui.get).
      name: 'view',
      read: () => {
        const ui = requireStore().getUI?.()
        return ui ? Object.fromEntries(SIDEBAR_VIEW_UI_FIELDS.map((key) => [key, ui[key]])) : {}
      },
      watch: (changed) => sources.store()?.onUIChanged?.(() => changed(urgent)) ?? (() => {})
    },
    {
      name: 'pairedServerHosts',
      read: () =>
        Object.fromEntries(
          pairedServerRows
            .snapshot()
            .servers.map(({ hostId, freshness, host }) => [hostId, { freshness, host }])
        ),
      watch: (changed) => pairedServerRows.revision.onChange(changed)
    },
    {
      name: 'pairedServerRows',
      read: () =>
        Object.fromEntries(
          pairedServerRows
            .snapshot()
            // Activity goes out in its own domain, so a terminal count does not resend the row.
            .servers.flatMap(({ rows }) =>
              rows.map(({ activity: _activity, ...row }) => [row.key, row])
            )
        ),
      watch: (changed) => pairedServerRows.revision.onChange(changed)
    },
    {
      name: 'desktop',
      // Each field its own entity.
      read: () => readRuntimeDesktopSidebarFacts(requireStore()),
      watch: (changed) => {
        const store = sources.store()
        const detaches = [
          watchCatalog(changed),
          store?.onWorkspaceSessionWritten?.(() => changed()),
          // Pins, settings (saved with or without notifying), UI, and full saves (repos, folders, SSH).
          store?.onStateWritten?.((domains) => {
            if (
              domains === undefined ||
              DESKTOP_WRITE_DOMAINS.some((domain) => domains.includes(domain))
            ) {
              changed(urgent)
            }
          }),
          getWslHostService()?.onStatusesChanged(changed)
        ]
        return () => detaches.forEach((detach) => detach?.())
      }
    },
    {
      // Each field its own entity, so a reader holds the catalog only once it is whole.
      name: 'projectCatalog',
      read: () => readSidebarProjectCatalog(requireStore(), pairedServerRows.catalogs()),
      watch: (changed) => {
        const detaches = [
          watchCatalog(changed),
          pairedServerRows.revision.onChange(changed),
          // Manual repo order and project order live in the UI state.
          sources.store()?.onUIChanged?.(() => changed()),
          // Catalog writes are full saves, and some (a project rename) announce no event.
          sources.store()?.onStateWritten?.((domains) => {
            if (domains === undefined) {
              changed()
            }
          })
        ]
        return () => detaches.forEach((detach) => detach?.())
      }
    },
    {
      // Ids only: a reader fetches the images through sidebarInputs.repoIcons.
      name: 'repoIcons',
      read: () => sources.repoIcons.idsByRepo(),
      watch: watchCatalog
    },
    {
      name: 'review',
      read: () => {
        const worktrees = workspaceRows.resolvedWorktrees()
        if (!worktrees) {
          return null
        }
        const store = requireStore()
        const prCache = store.getGitHubCache().pr
        return {
          ...buildWorkspaceReviewFacts(worktrees, store.getRepos(), prCache),
          // A paired server's rows by the window's cache too.
          ...buildPairedServerReviewFacts(pairedServerRows.snapshot().servers, prCache)
        }
      },
      watch: (changed) => {
        const detaches = [
          watchCatalog(changed),
          // A branch or link change reaches the facts through the rows' revision.
          workspaceRows.revision.onChange(changed),
          pairedServerRows.revision.onChange(changed),
          sources.store()?.onGitHubCacheWritten?.(changed)
        ]
        return () => detaches.forEach((detach) => detach?.())
      },
      ready: () => workspaceRows.ready()
    }
  ]
}
