import {
  readRuntimeDesktopSidebarFacts,
  CATALOG_EVENTS,
  SIDEBAR_VIEW_UI_FIELDS,
  DESKTOP_WRITE_DOMAINS
} from './sidebar-inputs-desktop-facts'
export { readRuntimeDesktopSidebarFacts } from './sidebar-inputs-desktop-facts'

import { getWslHostService } from '../../wsl/host-lifecycle/wsl-host-service-instance'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'

import type { RuntimeStore } from '../construction/runtime-store-contract'
import { savedWorkspaceCatalog } from '../../persistence/profile-save-domains'

import type { OrcaRuntimeWithSidebarTemporal } from './orca-runtime-sidebar-temporal'
import type { PairedServerRowsSnapshot } from '../../../shared/sidebar-list/feed-facts/paired-server-rows'
import type { PairedServerRowsProducer } from './workspace-rows/paired-server-rows-producer'
import type { WorkspaceLifecycleQueue } from '../workspaces/lifecycle/workspace-lifecycle-queue'
import type { WorkspaceRowsProducer } from './workspace-rows/workspace-rows-producer'
import type { RepoIconDataUrls } from './repo-icons/repo-icon-data-urls'
import type { SidebarInputsFeedDomain } from './feed/sidebar-inputs-feed'

import { readStoreInstallationId } from '../hosts/platform-probe/host-descriptor'
import { getCanonicalUserDataPath } from '../../persistence/loading-store/user-data-path'
import { readSidebarProjectCatalog } from './catalog/sidebar-project-catalog'
import {
  buildPairedServerReviewFacts,
  buildWorkspaceReviewFacts
} from '../../../shared/sidebar-list/feed-facts/workspace-review-facts'
import { buildPairedServerActivityFacts } from '../../../shared/sidebar-list/feed-facts/paired-server-activity-facts'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { keyWorkspaceActivityByRow } from '../../../shared/sidebar-list/feed-facts/workspace-activity-facts'

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
  let preparedPaired: PairedServerRowsSnapshot | undefined
  const pairedSnapshot = (): PairedServerRowsSnapshot => {
    if (!preparedPaired) {
      throw new Error('paired server facts are not prepared')
    }
    return preparedPaired
  }
  const preparePaired = (consume: () => void): Promise<void> =>
    pairedServerRows.withPreparedSnapshot((snapshot) => {
      preparedPaired = snapshot
      try {
        consume()
      } finally {
        preparedPaired = undefined
      }
    })
  const watchCatalog = (changed: () => void): (() => void) =>
    sources.onClientEvent(
      (event) => {
        if (CATALOG_EVENTS.has(event.type)) {
          changed()
        }
      },
      { consumesTerminalSideEffects: false }
    )
  // Why: until the id loads, cross-store children stay standalone; its arrival is a desktop change.
  let installationId: string | undefined
  const installationLoaded = readStoreInstallationId(null, getCanonicalUserDataPath()).then(
    (id) => {
      installationId = id
    }
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
      prepare: preparePaired,
      read: () => {
        const rows = workspaceRows.snapshot()?.rows
        if (!rows) {
          return null
        }
        return {
          // This host's session tabs and agents are by bare id, so a same-id pair it lists share them.
          ...keyWorkspaceActivityByRow(facts.getWorkspaceActivityFacts().facts, rows),
          ...buildPairedServerActivityFacts(
            pairedSnapshot().servers,
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
      prepare: preparePaired,
      read: () =>
        Object.fromEntries(
          pairedSnapshot().servers.map(({ hostId, freshness, host }) => [
            hostId,
            { freshness, host }
          ])
        ),
      watch: (changed) => {
        const detaches = [
          pairedServerRows.revision.onChange(changed),
          sources.store()?.onStateWritten?.((domains) => {
            if (domains?.includes('settings')) {
              changed()
            }
          }),
          sources.onClientEvent(
            (event) => {
              if (event.type === 'sshStateChanged') {
                changed()
              }
            },
            { consumesTerminalSideEffects: false }
          )
        ]
        return () => detaches.forEach((detach) => detach?.())
      }
    },
    {
      name: 'pairedServerRows',
      prepare: preparePaired,
      read: () =>
        Object.fromEntries(
          pairedSnapshot()
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
      read: () => readRuntimeDesktopSidebarFacts(requireStore(), installationId),
      watch: (changed) => {
        const store = sources.store()
        const detaches = [
          watchCatalog(changed),
          store?.onWorkspaceSessionWritten?.(() => changed()),
          // Pins, settings (saved with or without notifying), UI, and catalog saves (repos, folders, SSH).
          store?.onStateWritten?.((domains) => {
            if (
              savedWorkspaceCatalog(domains) ||
              DESKTOP_WRITE_DOMAINS.some((domain) => domains?.includes(domain))
            ) {
              changed(urgent)
            }
          }),
          getWslHostService()?.onStatusesChanged(changed)
        ]
        let watching = true
        void installationLoaded.then(() => {
          if (watching && installationId !== undefined) {
            changed()
          }
        })
        return () => {
          watching = false
          detaches.forEach((detach) => detach?.())
        }
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
          // Some catalog writes (a project rename) announce no event.
          sources.store()?.onStateWritten?.((domains) => {
            if (savedWorkspaceCatalog(domains)) {
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
      prepare: preparePaired,
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
          ...buildPairedServerReviewFacts(pairedSnapshot().servers, prCache)
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
