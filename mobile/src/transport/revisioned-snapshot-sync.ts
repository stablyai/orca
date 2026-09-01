// Why: the agent catalog and agent-reference snapshots are both authoritative,
// revisioned full replacements synced from the runtime host. They share one
// discipline — full replacement (never merge with local state), single-flight
// coalesced refetch, and per-host caching — so that discipline lives here and
// the two snapshot modules stay thin wrappers.
//
// Host identity: mobile keys every connection by its host id (see
// client-context.tsx), and each RpcClient targets exactly one runtime host, so
// the host id is a stable proxy for the authenticated _meta.runtimeId. A
// superseded connection is fenced by a per-host epoch; a runtime-id change on
// the same host id discards the prior state even when the new revision is lower.

export type RevisionedSnapshot = { revision: number }

export type SnapshotFetchOutcome<V> =
  | { kind: 'value'; runtimeId: string; value: V }
  // Transient failure (client not connected, RPC rejected, malformed frame).
  // The cached value is left untouched; a later event or reconnect re-drives.
  | { kind: 'unavailable' }
  // The host answered and authoritatively publishes NO snapshot (a downgraded or
  // pre-catalog host). Distinct from 'unavailable': keeping the cache here would
  // keep offering agents this host can no longer launch, so it is dropped.
  | { kind: 'absent'; runtimeId: string }

export type SnapshotFetch<V> = () => Promise<SnapshotFetchOutcome<V>>

export type SnapshotSyncConnection = {
  // Reconnect hydrate: replace the cached value on the next completed fetch
  // regardless of revision.
  hydrate: () => void
  // A change event announced a newer revision; folded into the single-flight
  // fetch loop.
  announce: (revision: number) => void
  // Stop this connection from driving the cache. Any later openConnection for
  // the same host supersedes it.
  dispose: () => void
}

export type RevisionedSnapshotSync<V extends RevisionedSnapshot> = {
  openConnection: (hostId: string, fetch: SnapshotFetch<V>) => SnapshotSyncConnection
  clear: (hostId: string) => void
  getSnapshot: (hostId: string) => V | null
  subscribe: (hostId: string, listener: () => void) => () => void
  // Hosts still holding a state entry; proves clear() drops the key, not just the value.
  trackedHostCountForTests: () => number
}

type HostState<V> = {
  value: V | null
  runtimeId: string | null
  // Bumped on openConnection/dispose/clear so an in-flight fetch or a stale
  // connection handle can detect it has been superseded and stand down.
  epoch: number
  fetch: SnapshotFetch<V> | null
  fetching: boolean
  hydratePending: boolean
  highestAnnounced: number | null
}

export function createRevisionedSnapshotSync<
  V extends RevisionedSnapshot
>(): RevisionedSnapshotSync<V> {
  const states = new Map<string, HostState<V>>()
  const listeners = new Map<string, Set<() => void>>()

  function stateFor(hostId: string): HostState<V> {
    let state = states.get(hostId)
    if (!state) {
      state = {
        value: null,
        runtimeId: null,
        epoch: 0,
        fetch: null,
        fetching: false,
        hydratePending: false,
        highestAnnounced: null
      }
      states.set(hostId, state)
    }
    return state
  }

  function notify(hostId: string): void {
    const set = listeners.get(hostId)
    if (!set) {
      return
    }
    for (const listener of set) {
      listener()
    }
  }

  function needsFetch(state: HostState<V>): boolean {
    if (state.hydratePending) {
      return true
    }
    const cachedRevision = state.value?.revision ?? -1
    return state.highestAnnounced != null && state.highestAnnounced > cachedRevision
  }

  function applyValue(
    hostId: string,
    state: HostState<V>,
    runtimeId: string,
    value: V,
    unconditional: boolean
  ): void {
    const runtimeChanged = state.runtimeId != null && state.runtimeId !== runtimeId
    state.runtimeId = runtimeId
    if (runtimeChanged) {
      // The host id now speaks for a different runtime; discard the prior
      // state even when the new revision is lower.
      state.value = value
      notify(hostId)
      return
    }
    const cachedRevision = state.value?.revision ?? -1
    if (unconditional || value.revision > cachedRevision) {
      state.value = value
      notify(hostId)
    }
  }

  function drive(hostId: string, state: HostState<V>): void {
    if (state.fetching || !state.fetch || !needsFetch(state)) {
      return
    }
    const fetch = state.fetch
    const myEpoch = state.epoch
    const wasHydrate = state.hydratePending
    const revisionBeforeFetch = state.value?.revision ?? -1
    state.fetching = true
    void fetch().then((outcome) => {
      // Ignore a fetch whose connection was replaced/disposed/cleared mid-flight.
      if (state.epoch !== myEpoch) {
        return
      }
      state.fetching = false
      if (outcome.kind === 'unavailable') {
        // Do not self-chain on transient failure; a tight loop against a
        // failing client would follow. The next event or reconnect re-drives.
        return
      }
      if (wasHydrate) {
        state.hydratePending = false
      }
      if (outcome.kind === 'absent') {
        state.runtimeId = outcome.runtimeId
        // Announced revisions describe a snapshot this host no longer publishes;
        // clearing them stops needsFetch from self-chaining against it.
        state.highestAnnounced = null
        if (state.value !== null) {
          state.value = null
          notify(hostId)
        }
        return
      }
      applyValue(hostId, state, outcome.runtimeId, outcome.value, wasHydrate)
      // Follow-up only while making progress: a host that persistently serves
      // a revision below highestAnnounced must not self-chain into an unbounded
      // RPC loop. Each chained fetch must advance the revision (bounded by
      // highestAnnounced); otherwise stand down until the next announce/hydrate.
      if (wasHydrate || outcome.value.revision > revisionBeforeFetch) {
        drive(hostId, state)
      }
    })
  }

  return {
    openConnection(hostId, fetch) {
      const state = stateFor(hostId)
      state.epoch += 1
      state.fetch = fetch
      state.fetching = false
      state.hydratePending = false
      state.highestAnnounced = null
      const myEpoch = state.epoch
      return {
        hydrate() {
          if (state.epoch !== myEpoch) {
            return
          }
          state.hydratePending = true
          drive(hostId, state)
        },
        announce(revision) {
          if (state.epoch !== myEpoch) {
            return
          }
          if (state.highestAnnounced == null || revision > state.highestAnnounced) {
            state.highestAnnounced = revision
          }
          drive(hostId, state)
        },
        dispose() {
          if (state.epoch !== myEpoch) {
            return
          }
          state.epoch += 1
          state.fetch = null
          state.fetching = false
          state.hydratePending = false
          state.highestAnnounced = null
        }
      }
    },
    clear(hostId) {
      const state = states.get(hostId)
      if (!state) {
        return
      }
      // Fence in-flight fetches and stale handles on the object they captured,
      // THEN drop the key — keeping every host ever connected to would grow this
      // map for the process lifetime.
      state.epoch += 1
      state.value = null
      state.runtimeId = null
      state.fetch = null
      state.fetching = false
      state.hydratePending = false
      state.highestAnnounced = null
      states.delete(hostId)
      notify(hostId)
    },
    getSnapshot(hostId) {
      return states.get(hostId)?.value ?? null
    },
    trackedHostCountForTests() {
      return states.size
    },
    subscribe(hostId, listener) {
      let set = listeners.get(hostId)
      if (!set) {
        set = new Set()
        listeners.set(hostId, set)
      }
      set.add(listener)
      return () => {
        const current = listeners.get(hostId)
        if (!current) {
          return
        }
        current.delete(listener)
        if (current.size === 0) {
          listeners.delete(hostId)
        }
      }
    }
  }
}
