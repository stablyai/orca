import {
  getRegisteredSshState,
  listRegisteredSshTargets
} from '../../ssh/targets/ssh-target-registry'
import { getWslHostService } from '../../wsl/wsl-host-service-instance'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import type { DesktopSidebarFacts } from '../../../shared/sidebar-list/desktop-sidebar-facts'
import type { RuntimeStore } from '../runtime-store-contract'
import type { OrcaRuntimeWithSidebarTemporal } from './orca-runtime-sidebar-temporal'
import type { PairedServerRowsProducer } from './paired-server-rows-producer'
import type { WorkspaceCreationRegistry } from './workspace-creation-registry'
import type { WorkspaceRowsProducer } from './workspace-rows-producer'
import type { RepoIconDataUrls } from './repo-icon-data-urls'
import type { SidebarInputsFeedDomain } from './sidebar-inputs-feed'
import { readDesktopSidebarFacts } from './desktop-sidebar-facts'
import { readSidebarProjectCatalog } from './sidebar-project-catalog'
import { buildPairedServerReviewFacts } from '../../../shared/sidebar-list/workspace-review-facts'
import { buildPairedServerActivityFacts } from '../../../shared/sidebar-list/paired-server-activity-facts'
import { parseExecutionHostId } from '../../../shared/execution-host'

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

export type SidebarInputsFeedSources = {
  facts: OrcaRuntimeWithSidebarTemporal
  pairedServerRows: PairedServerRowsProducer
  workspaceCreations: WorkspaceCreationRegistry
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
  const { facts, pairedServerRows, workspaceCreations, workspaceRows } = sources
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
      read: () => ({
        // A paired server's rows too; this host's own rows win an id both list.
        ...buildPairedServerActivityFacts(
          pairedServerRows.snapshot().servers,
          (hostId) => sources.store()?.getWorkspaceSession?.(hostId) ?? null
        ),
        ...facts.getWorkspaceActivityFacts().facts
      }),
      watch: (changed) => {
        const detaches = [
          facts.workspaceActivityFacts.revision.onChange(changed),
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
      name: 'creations',
      read: () => workspaceCreations.snapshot().creations,
      watch: (changed) => workspaceCreations.revision.onChange(changed)
    },
    {
      name: 'workspaces',
      read: async () => (await workspaceRows.snapshot()).rows,
      watch: (changed) => workspaceRows.revision.onChange(changed)
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
      // Each field its own entity; the WSL registry announces no change.
      read: () => readRuntimeDesktopSidebarFacts(requireStore()),
      watch: (changed) => {
        const store = sources.store()
        const detaches = [
          watchCatalog(changed),
          store?.onUIChanged?.(changed),
          store?.onWorkspaceSessionWritten?.(changed),
          store?.onSettingsChanged?.(changed)
        ]
        return () => detaches.forEach((detach) => detach?.())
      },
      rereadOnRead: true
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
          sources.store()?.onUIChanged?.(changed),
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
      read: async () => ({
        // A paired server's rows by the window's cache too; this host's own rows win an id both list.
        ...buildPairedServerReviewFacts(
          pairedServerRows.snapshot().servers,
          requireStore().getGitHubCache().pr
        ),
        ...(await facts.getWorkspaceReviewFacts()).facts
      }),
      // The window's PR cache saves announce no change.
      watch: watchCatalog,
      rereadOnRead: true
    }
  ]
}
