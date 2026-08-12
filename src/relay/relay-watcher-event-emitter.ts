import type { WatcherProcessEvent } from '../main/ipc/parcel-watcher-process'
import { resolveRuntimePath } from '../shared/cross-platform-path'
import type { RelayDispatcher } from './dispatcher'

type MappedWatcherEvent = {
  kind: string
  absolutePath: string
  isDirectory?: boolean
}

type WatcherBatchSizing = {
  eventBytes: Map<MappedWatcherEvent, number>
  batchBytes: number
}

type OverflowMarkerState = {
  // Why: one outstanding marker per (client, root) keeps sustained backpressure bounded.
  inFlight: Set<string>
  // Rejected markers, retained per client so they can be republished when the control lane frees up.
  pending: Map<number, Map<string, number>>
  capacityUnsubscribes: Map<number, () => void>
}

const overflowMarkerStates = new WeakMap<RelayDispatcher, OverflowMarkerState>()

export function emitRelayWatcherEvents(
  dispatcher: RelayDispatcher,
  rootPath: string,
  closed: boolean,
  events: readonly WatcherProcessEvent[]
): void {
  if (closed || events.length === 0) {
    return
  }
  const mapped: MappedWatcherEvent[] = events.map((event) => ({
    kind: event.type,
    absolutePath: event.path,
    ...(event.isDirectory === undefined ? {} : { isDirectory: event.isDirectory })
  }))
  // Grouping walks every path, so only the chunking path pays for it — and only once across all clients.
  let grouped: MappedWatcherEvent[] | null = null
  const groupedByDirectory = (): MappedWatcherEvent[] =>
    (grouped ??= groupWatcherEventsByDirectory(mapped))
  let sizing: WatcherBatchSizing | null = null
  const batchSizing = (): WatcherBatchSizing => (sizing ??= measureWatcherBatch(mapped))
  for (const clientId of dispatcher.activeClientIds()) {
    publishWatcherBatchToClient(
      dispatcher,
      clientId,
      rootPath,
      mapped,
      groupedByDirectory,
      batchSizing
    )
  }
}

/**
 * Why: the renderer dedupes directory refreshes within a SINGLE fs.changed payload, so a directory
 * scattered across chunks costs one forced readDir RPC per chunk. Grouping is stable, so events for a
 * given path keep their relative order and a create-then-delete can never invert.
 */
function groupWatcherEventsByDirectory(
  mapped: readonly MappedWatcherEvent[]
): MappedWatcherEvent[] {
  const groups = new Map<string, MappedWatcherEvent[]>()
  for (const event of mapped) {
    // Runs on the remote host: derive the parent with the runtime-flavored resolver, not a '/' split.
    const parentPath = resolveRuntimePath(event.absolutePath, '..')
    const group = groups.get(parentPath)
    if (group) {
      group.push(event)
    } else {
      groups.set(parentPath, [event])
    }
  }
  return Array.from(groups.values()).flat()
}

function encodedWatcherEventBytes(event: MappedWatcherEvent): number {
  return Buffer.byteLength(JSON.stringify(event))
}

function measureWatcherBatch(mapped: readonly MappedWatcherEvent[]): WatcherBatchSizing {
  const eventBytes = new Map<MappedWatcherEvent, number>()
  let batchBytes = Math.max(0, mapped.length - 1)
  for (const event of mapped) {
    const bytes = encodedWatcherEventBytes(event)
    eventBytes.set(event, bytes)
    batchBytes += bytes
  }
  return { eventBytes, batchBytes }
}

// Batches are sized to each sink's frame capacity; a batch that cannot be sized degrades to an overflow resync.
function publishWatcherBatchToClient(
  dispatcher: RelayDispatcher,
  clientId: number,
  rootPath: string,
  mapped: readonly MappedWatcherEvent[],
  groupedByDirectory: () => readonly MappedWatcherEvent[],
  batchSizing: () => WatcherBatchSizing
): void {
  const publish = (events: readonly MappedWatcherEvent[]): boolean =>
    dispatcher.publishProducerNotification(clientId, 'fs.changed', { events })

  // Fast path: publish the whole batch before paying to group or size individual events.
  // logDrop:false because rejection here is a measurement, not an outcome: the batch is re-sent in
  // chunks below, so logging it would report a drop for events that all arrive.
  if (
    dispatcher.publishProducerNotification(
      clientId,
      'fs.changed',
      { events: mapped },
      {
        logDrop: false
      }
    )
  ) {
    return
  }

  // Rejection is ambiguous: an over-capacity frame is chunkable, a full producer queue is real data loss.
  // The empty envelope is encoded once; event JSON sizes are exact deltas apart from array commas.
  const eventsCapacity = dispatcher.producerEnvelopeBudget('fs.changed', { events: [] }, clientId)
  if (eventsCapacity < 0) {
    emitWatcherOverflowToClient(dispatcher, clientId, rootPath)
    return
  }
  const { eventBytes, batchBytes } = batchSizing()
  if (batchBytes <= eventsCapacity) {
    emitWatcherOverflowToClient(dispatcher, clientId, rootPath)
    return
  }

  const grouped = groupedByDirectory()
  const groupedEventBytes = grouped.map((event) => eventBytes.get(event)!)
  let index = 0
  while (index < grouped.length) {
    // Why: the retention ledger covers every producer publication despite its legacy name, and admission
    // is lane-agnostic: chunks queued past its low-water reserve (half the 2 MB queue) starve interactive
    // PTY frames until pty-handler pauses every remote pane. A resync costs the user far less.
    // Per client, never dispatcher-wide: one stalled peer must not cost a healthy client a resync,
    // which forces a readDir per directory in its file tree.
    if (!dispatcher.producerRetentionBelowLowWater(clientId)) {
      emitWatcherOverflowToClient(dispatcher, clientId, rootPath)
      return
    }
    let end = index
    let chunkBytes = 0
    while (end < grouped.length) {
      const nextBytes = groupedEventBytes[end] + (end === index ? 0 : 1)
      if (chunkBytes + nextBytes > eventsCapacity) {
        break
      }
      chunkBytes += nextBytes
      end += 1
    }
    if (end === index || !publish(grouped.slice(index, end))) {
      emitWatcherOverflowToClient(dispatcher, clientId, rootPath)
      return
    }
    index = end
  }
}

function overflowMarkerState(dispatcher: RelayDispatcher): OverflowMarkerState {
  const existing = overflowMarkerStates.get(dispatcher)
  if (existing) {
    return existing
  }
  const state: OverflowMarkerState = {
    inFlight: new Set(),
    pending: new Map(),
    capacityUnsubscribes: new Map()
  }
  overflowMarkerStates.set(dispatcher, state)
  // In-flight keys need no sweep here: closing a client settles every queued and written frame first.
  dispatcher.onClientDetached((clientId) => {
    // Not every detach retires the id: invalidateClient() detaches the primary without removing it and
    // setWrite() revives it, so dropping the markers here would desync the tree the reconnect restores.
    if (dispatcher.isClientAttached(clientId)) {
      return
    }
    forgetClientMarkers(state, clientId)
  })
  return state
}

function forgetClientMarkers(state: OverflowMarkerState, clientId: number): void {
  // Unsubscribe first so no re-entrant flush can observe a half-cleared client.
  state.capacityUnsubscribes.get(clientId)?.()
  state.capacityUnsubscribes.delete(clientId)
  state.pending.delete(clientId)
}

function overflowMarkerParams(rootPath: string): Record<string, unknown> {
  return { events: [{ kind: 'overflow', absolutePath: rootPath }] }
}

// Why: the control lane — on the producer lane the marker would hit the same full queue that just
// rejected the batch and be dropped, silently desyncing the remote file tree.
function emitWatcherOverflowToClient(
  dispatcher: RelayDispatcher,
  clientId: number,
  rootPath: string
): void {
  const state = overflowMarkerState(dispatcher)
  // Per root, never per client alone: an outstanding marker for one tree must not suppress another's resync.
  if (
    state.inFlight.has(`${clientId} ${rootPath}`) ||
    state.pending.get(clientId)?.has(rootPath) === true
  ) {
    return
  }
  publishOverflowMarker(dispatcher, state, clientId, rootPath)
}

function publishOverflowMarker(
  dispatcher: RelayDispatcher,
  state: OverflowMarkerState,
  clientId: number,
  rootPath: string,
  estimatedBytes?: number
): void {
  const key = `${clientId} ${rootPath}`
  const params = overflowMarkerParams(rootPath)
  const frameBytes = estimatedBytes ?? dispatcher.notificationFrameBytes('fs.changed', params)
  state.inFlight.add(key)
  let settled = false
  const accepted = dispatcher.tryNotifyClient(
    clientId,
    'fs.changed',
    params,
    (result) => {
      // Settles on write, drop, or client close, so the slot can never leak.
      settled = true
      state.inFlight.delete(key)
      if (result.ok) {
        return
      }
      // A frame the sink never wrote leaves the tree just as desynced as a rejected one — setWrite
      // fails every queued and in-flight frame this way. Retain unconditionally: a real detach clears
      // it through onClientDetached, which fires after this settlement.
      retainOverflowMarker(dispatcher, state, clientId, rootPath, frameBytes)
    },
    { controlOverflow: 'reject' }
  )
  if (accepted || settled) {
    return
  }
  // Admission rejection has no settlement callback: retain the marker instead of desyncing the tree.
  state.inFlight.delete(key)
  retainOverflowMarker(dispatcher, state, clientId, rootPath, frameBytes)
}

function retainOverflowMarker(
  dispatcher: RelayDispatcher,
  state: OverflowMarkerState,
  clientId: number,
  rootPath: string,
  estimatedBytes: number
): void {
  if (!state.capacityUnsubscribes.has(clientId)) {
    const unsubscribe = dispatcher.onClientCapacity(clientId, () =>
      flushPendingOverflowMarkers(dispatcher, state, clientId)
    )
    if (!unsubscribe) {
      // The client went away between admission and arming, so there is nothing left to resync.
      return
    }
    state.capacityUnsubscribes.set(clientId, unsubscribe)
  }
  const roots = state.pending.get(clientId)
  if (roots) {
    roots.set(rootPath, estimatedBytes)
    return
  }
  state.pending.set(clientId, new Map([[rootPath, estimatedBytes]]))
}

function flushPendingOverflowMarkers(
  dispatcher: RelayDispatcher,
  state: OverflowMarkerState,
  clientId: number
): void {
  const roots = state.pending.get(clientId)
  if (!roots) {
    return
  }
  for (const [rootPath, estimatedBytes] of Array.from(roots)) {
    // Capacity fires on every lane; retry only frames the control queue can admit now.
    if (!dispatcher.canAdmitControlFrame(clientId, estimatedBytes)) {
      continue
    }
    // Drop before republishing so a synchronous settlement cannot see the marker as still pending —
    // and skip roots a re-entrant flush already took, which would otherwise send the marker twice.
    if (!roots.delete(rootPath)) {
      continue
    }
    publishOverflowMarker(dispatcher, state, clientId, rootPath, estimatedBytes)
  }
  // Identity check: a re-entrant flush may have retired this set and armed a fresh one to keep.
  if (roots.size > 0 || state.pending.get(clientId) !== roots) {
    return
  }
  forgetClientMarkers(state, clientId)
}

export function emitRelayWatcherOverflow(
  dispatcher: RelayDispatcher,
  rootPath: string,
  closed: boolean
): void {
  if (closed) {
    return
  }
  for (const clientId of dispatcher.activeClientIds()) {
    emitWatcherOverflowToClient(dispatcher, clientId, rootPath)
  }
}
