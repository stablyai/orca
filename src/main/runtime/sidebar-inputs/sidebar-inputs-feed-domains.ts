import { getRegisteredSshState, listRegisteredSshTargets } from '../../ssh/ssh-target-registry'
import { getWslHostService } from '../../wsl/wsl-host-service-instance'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import type { DesktopSidebarFacts } from '../../../shared/sidebar-list/desktop-sidebar-facts'
import type { RuntimeStore } from '../runtime-store-contract'
import type { OrcaRuntimeWithSidebarTemporal } from './orca-runtime-sidebar-temporal'
import type { PairedServerRowsProducer } from './paired-server-rows-producer'
import type { WorkspaceCreationRegistry } from './workspace-creation-registry'
import type { WorkspaceRowsProducer } from './workspace-rows-producer'
import type { SidebarInputsFeedDomain } from './sidebar-inputs-feed'
import { readDesktopSidebarFacts } from './desktop-sidebar-facts'

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
      read: () => facts.getWorkspaceActivityFacts().facts,
      watch: (changed) => facts.workspaceActivityFacts.revision.onChange(changed)
    },
    {
      name: 'temporal',
      read: () => {
        const { sessionId, sortSnapshot, retention } = facts.getSidebarTemporalSnapshot()
        return { sessionId, sortSnapshot, retention }
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
            .servers.flatMap(({ rows }) => rows.map((row) => [row.key, row]))
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
          store?.onWorkspaceSessionWritten?.(changed)
        ]
        return () => detaches.forEach((detach) => detach?.())
      },
      rereadOnRead: true
    },
    {
      name: 'review',
      read: async () => (await facts.getWorkspaceReviewFacts()).facts,
      // The window's PR cache saves announce no change.
      watch: watchCatalog,
      rereadOnRead: true
    }
  ]
}
