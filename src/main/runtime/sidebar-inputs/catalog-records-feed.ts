import { getRepoHostIdentity } from '../../../shared/repo-host-identity'
import type { SidebarProjectCatalogRecords } from '../../../shared/sidebar-list/sidebar-project-catalog'
import {
  CATALOG_RECORDS_DOMAIN,
  type CatalogRecordsOrder
} from '../../../shared/sidebar-list/catalog-records-feed-contract'
import { watchProjectCatalogWrites, type CatalogWatchSources } from './catalog-watch'
import { SidebarInputsFeed, type SidebarInputsFeedDomain } from './sidebar-inputs-feed'
import {
  readSidebarCatalogRecords,
  type SidebarProjectCatalogStore
} from './sidebar-project-catalog'
import type { SidebarInputsChangedEvent } from '../../../shared/sidebar-list/sidebar-inputs-feed-contract'
import type { PairedServerRowsProducer } from './paired-server-rows-producer'

/** One entity per row, so a group rename re-sends that group, not every repo. */
export function catalogRecordEntities(
  records: SidebarProjectCatalogRecords
): Record<string, unknown> {
  const entities: Record<string, unknown> = {}
  const order: CatalogRecordsOrder = {
    repos: [],
    projectGroups: [],
    projects: [],
    projectHostSetups: []
  }
  const put = (list: string[], key: string, row: unknown): void => {
    // A duplicate key keeps both rows apart, in order.
    let unique = key
    for (let n = 1; unique in entities; n += 1) {
      unique = `${key}#${n}`
    }
    entities[unique] = row
    list.push(unique)
  }
  records.repos.forEach((repo) => put(order.repos, `repo:${getRepoHostIdentity(repo)}`, repo))
  records.projectGroups.forEach((group) =>
    put(order.projectGroups, `group:${group.executionHostId ?? ''}\0${group.id}`, group)
  )
  records.projects.forEach((project) => put(order.projects, `project:${project.id}`, project))
  records.projectHostSetups.forEach((setup) =>
    put(order.projectHostSetups, `setup:${setup.hostId}\0${setup.id}`, setup)
  )
  entities.order = order
  return entities
}

export type CatalogRecordsFeedSources = Omit<CatalogWatchSources, 'store'> & {
  store: () => (SidebarProjectCatalogStore & ReturnType<CatalogWatchSources['store']>) | null
  pairedServerRows: Pick<PairedServerRowsProducer, 'revision' | 'catalogs'>
}

/**
 * The desktop window's project catalog: main's own rows straight from its store, never waiting
 * on a workspace scan. Its own feed, so a phone (which builds from projectCatalog) never reads it.
 */
export function createCatalogRecordsFeed(
  sources: CatalogRecordsFeedSources,
  emit: (event: SidebarInputsChangedEvent) => void
): SidebarInputsFeed {
  const domain: SidebarInputsFeedDomain = {
    name: CATALOG_RECORDS_DOMAIN,
    read: () => {
      const store = sources.store()
      return store
        ? catalogRecordEntities(
            readSidebarCatalogRecords(store, sources.pairedServerRows.catalogs())
          )
        : null
    },
    watch: (changed) => watchProjectCatalogWrites(sources, changed)
  }
  return new SidebarInputsFeed(() => [domain], emit)
}

type CatalogRecordsRuntime = {
  pairedServerRows: CatalogRecordsFeedSources['pairedServerRows'] | null
  requireStore: () => NonNullable<ReturnType<CatalogRecordsFeedSources['store']>>
  onClientEvent: CatalogRecordsFeedSources['onClientEvent']
}

type CatalogRecordsFeedEntry = {
  feed: SidebarInputsFeed
  listeners: Set<(event: SidebarInputsChangedEvent) => void>
}

const feedsByRuntime = new WeakMap<CatalogRecordsRuntime, CatalogRecordsFeedEntry>()

function entryOf(runtime: CatalogRecordsRuntime): CatalogRecordsFeedEntry | null {
  const pairedServerRows = runtime.pairedServerRows
  if (!pairedServerRows) {
    return null
  }
  let entry = feedsByRuntime.get(runtime)
  if (!entry) {
    const listeners = new Set<(event: SidebarInputsChangedEvent) => void>()
    const feed = createCatalogRecordsFeed(
      {
        pairedServerRows,
        store: () => {
          try {
            return runtime.requireStore()
          } catch {
            return null
          }
        },
        onClientEvent: (listener, options) => runtime.onClientEvent(listener, options)
      },
      (event) => listeners.forEach((listener) => listener(event))
    )
    entry = { feed, listeners }
    feedsByRuntime.set(runtime, entry)
  }
  return entry
}

/** This runtime's catalog feed; null in a build without the sidebar feed. */
export function catalogRecordsFeedOf(runtime: CatalogRecordsRuntime): SidebarInputsFeed | null {
  return entryOf(runtime)?.feed ?? null
}

/** Hears each change of this runtime's catalog feed; only the desktop window listens. */
export function onCatalogRecordsChanged(
  runtime: CatalogRecordsRuntime,
  listener: (event: SidebarInputsChangedEvent) => void
): () => void {
  const entry = entryOf(runtime)
  entry?.listeners.add(listener)
  return () => entry?.listeners.delete(listener)
}

// Process-wide: the desktop window is the catalog feed's only reader.
const readListeners = new Set<() => void>()

/** Runs on each read of the catalog feed, as repos:list ran for each window catalog fetch. */
export function onCatalogRecordsRead(listener: () => void): () => void {
  readListeners.add(listener)
  return () => readListeners.delete(listener)
}

export function noteCatalogRecordsRead(): void {
  readListeners.forEach((listener) => listener())
}
