import type { WatcherProcessEvent } from '../main/ipc/parcel-watcher-process'
import { resolveRuntimePath } from '../shared/cross-platform-path'
import type { RelayDispatcher } from './dispatcher'
import {
  createRelayClientResyncMarkerPublisher,
  type RelayClientResyncMarkerPublisher
} from './relay-client-resync-marker'

type MappedWatcherEvent = {
  kind: string
  absolutePath: string
  isDirectory?: boolean
}

type WatcherBatchSizing = {
  eventBytes: Map<MappedWatcherEvent, number>
  batchBytes: number
}

const overflowMarkerPublishers = new WeakMap<RelayDispatcher, RelayClientResyncMarkerPublisher>()

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

function overflowMarkerPublisher(dispatcher: RelayDispatcher): RelayClientResyncMarkerPublisher {
  const existing = overflowMarkerPublishers.get(dispatcher)
  if (existing) {
    return existing
  }
  const publisher = createRelayClientResyncMarkerPublisher(dispatcher, 'fs.changed')
  overflowMarkerPublishers.set(dispatcher, publisher)
  return publisher
}

function overflowMarkerParams(rootPath: string): Record<string, unknown> {
  return { events: [{ kind: 'overflow', absolutePath: rootPath }] }
}

function emitWatcherOverflowToClient(
  dispatcher: RelayDispatcher,
  clientId: number,
  rootPath: string
): void {
  overflowMarkerPublisher(dispatcher).emit(clientId, rootPath, overflowMarkerParams(rootPath))
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
