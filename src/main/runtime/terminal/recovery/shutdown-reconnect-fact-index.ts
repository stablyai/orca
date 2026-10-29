import { ReconnectContributions } from './shutdown-reconnect-contributions'

import type { SessionChangeSet } from '../../../../shared/session-change-set'
import { SessionUnitIndex } from '../../../../shared/session-unit-index'
import type {
  SessionUnitReader,
  SessionUnitSelection
} from '../../../../shared/session-unit-reader'

import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import type { ReconnectFactSources, ShutdownReconnectFacts } from './shutdown-reconnect-facts'

/** A candidate owns touched contributions; aggregate iteration is reserved for changed outputs. */

const indexByRoot = new WeakMap<WorkspaceSessionState, SessionUnitIndex>()
const cachesByIndex = new WeakMap<SessionUnitIndex, Set<WeakRef<ReconnectContributions>>>()
const cachesByOwner = new WeakMap<object, WeakMap<SessionUnitIndex, ReconnectContributions>>()
const liveSubscribers = new WeakMap<object, Set<WeakRef<ReconnectContributions>>>()

export function registerReconnectRoot(root: WorkspaceSessionState, index: SessionUnitIndex): void {
  indexByRoot.set(root, index)
}

/** Live facts invalidate only panes naming that PTY, independently of renderer map edits. */
export function invalidateShutdownReconnectPty(
  owner: NonNullable<ReconnectFactSources['factOwner']>,
  ptyId: string
): void {
  const subscribers = liveSubscribers.get(owner)
  for (const reference of subscribers ?? []) {
    const cache = reference.deref()
    if (cache) {
      cache.dirtyPtys.add(ptyId)
    } else {
      subscribers?.delete(reference)
    }
  }
}

export function publishReconnectRoot(
  root: WorkspaceSessionState,
  index: SessionUnitIndex,
  event: SessionChangeSet,
  orderChanged: boolean
): void {
  registerReconnectRoot(root, index)
  const caches = cachesByIndex.get(index)
  for (const reference of caches ?? []) {
    const cache = reference.deref()
    if (!cache) {
      caches?.delete(reference)
      continue
    }
    cache.root = root
    if (event.fullReplacement || orderChanged) {
      cache.initialized = false
    }
    for (const owner of event.owners) {
      cache.dirtyOwners.add(owner)
    }
  }
}

/** Counted static contributions and evaluated facts are rebuildable, never saved authority. */

function contributions(
  root: WorkspaceSessionState,
  index: SessionUnitIndex,
  sources: ReconnectFactSources
): ReconnectContributions {
  const owner = sources.factOwner ?? sources
  const byIndex =
    cachesByOwner.get(owner) ?? new WeakMap<SessionUnitIndex, ReconnectContributions>()
  cachesByOwner.set(owner, byIndex)
  let cache = byIndex.get(index)
  if (!cache) {
    cache = new ReconnectContributions(root, index)
    byIndex.set(index, cache)
    const reference = new WeakRef(cache)
    const subscribers = liveSubscribers.get(owner) ?? new Set<WeakRef<ReconnectContributions>>()
    subscribers.add(reference)
    liveSubscribers.set(owner, subscribers)
    const published = cachesByIndex.get(index) ?? new Set<WeakRef<ReconnectContributions>>()
    published.add(reference)
    cachesByIndex.set(index, published)
  }
  cache.refresh(sources)
  return cache
}

export function deriveIndexedShutdownReconnectFacts(
  reader: SessionUnitReader,
  selection: SessionUnitSelection,
  sources: ReconnectFactSources
): ShutdownReconnectFacts {
  const prior = contributions(reader.prior, reader.index, sources)
  const candidate = prior.candidate()
  const owners = reader.affectedOwners(selection)
  candidate.update(
    reader,
    owners,
    sources,
    (keys) => reader.orderSelection('tabsByWorktree', keys),
    (tab) => reader.terminalOwners(tab),
    reader.replaces('tabsByWorktree')
  )
  const others = (sources.otherPartitions?.() ?? []).map((root) => {
    let index = indexByRoot.get(root)
    if (!index) {
      index = new SessionUnitIndex(root)
      registerReconnectRoot(root, index)
    }
    return contributions(root, index, sources)
  })
  return candidate.facts(sources, others)
}
