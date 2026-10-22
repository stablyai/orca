import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import type { RuntimeStore } from '../runtime-store-contract'
import type { PairedServerRowsProducer } from './paired-server-rows-producer'
import type { SidebarInputsFeedChange } from './sidebar-inputs-feed'

// The bus every catalog, view and SSH change reaches clients through.
export const CATALOG_EVENTS = new Set<RuntimeClientEvent['type']>([
  'worktreesChanged',
  'reposChanged',
  'workspaceViewChanged',
  'sshStateChanged'
])

export type CatalogWatchSources = {
  pairedServerRows: Pick<PairedServerRowsProducer, 'revision'>
  store: () => Partial<Pick<RuntimeStore, 'onUIChanged' | 'onStateWritten'>> | null
  onClientEvent: (
    listener: (event: RuntimeClientEvent) => void,
    options: { consumesTerminalSideEffects: false }
  ) => () => void
}

export function watchCatalogEvents(
  sources: Pick<CatalogWatchSources, 'onClientEvent'>,
  changed: () => void
): () => void {
  return sources.onClientEvent(
    (event) => {
      if (CATALOG_EVENTS.has(event.type)) {
        changed()
      }
    },
    { consumesTerminalSideEffects: false }
  )
}

const URGENT = { urgent: true }

/** Every write of the project catalog; a catalog write is a request a reader shows only once main publishes it. */
export function watchProjectCatalogWrites(
  sources: CatalogWatchSources,
  changed: (change?: SidebarInputsFeedChange) => void
): () => void {
  const changedNow = (): void => changed(URGENT)
  const detaches = [
    watchCatalogEvents(sources, changedNow),
    sources.pairedServerRows.revision.onChange(() => changed()),
    // Manual repo order and project order live in the UI state.
    sources.store()?.onUIChanged?.(changedNow),
    // Catalog writes are full saves, and some (a project rename) announce no event.
    sources.store()?.onStateWritten?.((domains) => {
      if (domains === undefined) {
        changedNow()
      }
    })
  ]
  return () => detaches.forEach((detach) => detach?.())
}
