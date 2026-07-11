import {
  boundedFileSystemOperation,
  createSafetySnapshotEntry,
  defaultSafetyFileSystem,
  isInvisibleFileSystemError,
  type SafetyScanOptions,
  type SafetySnapshot,
  type SafetySnapshotEntry
} from './wsl-watcher-host-checkpoint'

export { scanWatcherSafetySnapshot } from './wsl-watcher-host-checkpoint'
export type {
  SafetyFileSystem,
  SafetyScanOptions,
  SafetyScanResult,
  SafetySnapshot,
  SafetySnapshotEntry
} from './wsl-watcher-host-checkpoint'

export type SafetyWatcherEvent = {
  type: 'create' | 'update' | 'delete'
  path: string
}

export type NativeEventApplicationResult = 'applied' | 'cancelled' | 'topology'
export type WatcherHostOutput = {
  write(chunk: string): boolean
  once(event: 'drain' | 'error', listener: () => void): unknown
}

const MAX_PROTOCOL_QUEUE_BYTES = 4 * 1024 * 1024
const DEFAULT_NATIVE_EVENT_DURATION_MS = 5_000

export function watcherSafetyDelay(key: string, eventCount: number, idleRounds: number): number {
  const base =
    eventCount >= 1_000
      ? 5_000
      : eventCount > 0
        ? 30_000
        : Math.min(60_000 * 2 ** Math.min(idleRounds, 3), 300_000)
  let hash = 0
  for (const character of key) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  }
  return Math.round(base * (0.8 + (hash % 401) / 1_000))
}

function effectiveSnapshotEntry(
  snapshot: SafetySnapshot,
  changes: Map<string, SafetySnapshotEntry | null>,
  path: string
): SafetySnapshotEntry | undefined {
  const changed = changes.get(path)
  return changes.has(path) ? (changed ?? undefined) : snapshot.get(path)
}

export async function applyNativeEventsToSafetySnapshot(
  root: string,
  snapshot: SafetySnapshot,
  events: SafetyWatcherEvent[],
  options: SafetyScanOptions = {}
): Promise<NativeEventApplicationResult> {
  const changes = new Map<string, SafetySnapshotEntry | null>()
  const now = options.now ?? Date.now
  const deadline = now() + (options.maxDurationMs ?? DEFAULT_NATIVE_EVENT_DURATION_MS)
  const fileSystem = options.fileSystem ?? defaultSafetyFileSystem
  for (const event of events) {
    const eventPath = event.path
    const previous = effectiveSnapshotEntry(snapshot, changes, eventPath)
    if (event.type === 'delete') {
      if (eventPath === root || previous?.directory) {
        return 'topology'
      }
      changes.set(eventPath, null)
      continue
    }
    const statResult = await boundedFileSystemOperation(
      () => fileSystem.lstat(eventPath),
      options.signal,
      deadline,
      now
    )
    if (statResult.kind === 'cancelled') {
      return 'cancelled'
    }
    if (statResult.kind === 'time-limit' || statResult.kind === 'resource-limit') {
      return 'topology'
    }
    if (statResult.kind === 'error') {
      // Why: vanished and unreadable paths are equally invisible to safety
      // scans; only unknown I/O failures leave the topology uncertain.
      if (!isInvisibleFileSystemError(statResult.error)) {
        return 'topology'
      }
      if (previous?.directory) {
        return 'topology'
      }
      changes.set(eventPath, null)
      continue
    }
    const next = createSafetySnapshotEntry(statResult.value)
    if (previous?.directory !== next.directory && previous !== undefined) {
      return 'topology'
    }
    if (next.directory && previous?.signature !== undefined) {
      if (previous.signature !== next.signature) {
        return 'topology'
      }
    } else if (next.directory) {
      const readResult = await boundedFileSystemOperation(
        () => fileSystem.readdir(eventPath),
        options.signal,
        deadline,
        now
      )
      if (readResult.kind === 'cancelled') {
        return 'cancelled'
      }
      if (readResult.kind !== 'complete' || readResult.value.length > 0) {
        return 'topology'
      }
    }
    changes.set(eventPath, next)
  }
  for (const [path, entry] of changes) {
    if (entry) {
      snapshot.set(path, entry)
    } else {
      snapshot.delete(path)
    }
  }
  return 'applied'
}

export function reconcileWatcherSafetySnapshots(
  previous: SafetySnapshot,
  next: SafetySnapshot
): { events: SafetyWatcherEvent[]; topologyChanged: boolean } {
  const events: SafetyWatcherEvent[] = []
  let topologyChanged = false
  for (const [entryPath, nextEntry] of next) {
    const prior = previous.get(entryPath)
    if (!prior) {
      topologyChanged ||= nextEntry.directory
      events.push({ type: 'create', path: entryPath })
    } else if (
      prior.directory !== nextEntry.directory ||
      (nextEntry.directory && prior.signature !== nextEntry.signature)
    ) {
      topologyChanged = true
    } else if (prior.signature !== nextEntry.signature) {
      events.push({ type: 'update', path: entryPath })
    }
  }
  for (const [entryPath, prior] of previous) {
    if (!next.has(entryPath)) {
      topologyChanged ||= prior.directory
      events.push({ type: 'delete', path: entryPath })
    }
  }
  return { events, topologyChanged }
}

export function createBoundedProtocolWriter(
  output: WatcherHostOutput,
  exit: (code: number) => void
): (message: object) => void {
  const queued: { line: string; bytes: number }[] = []
  let pendingBytes = 0
  let blockedBytes = 0
  let blocked = false
  let stopped = false

  const fail = (): void => {
    if (stopped) {
      return
    }
    stopped = true
    queued.length = 0
    pendingBytes = 0
    exit(3)
  }
  const flush = (): void => {
    while (!stopped && !blocked && queued.length > 0) {
      const next = queued.shift() as { line: string; bytes: number }
      try {
        if (output.write(next.line)) {
          pendingBytes -= next.bytes
        } else {
          blocked = true
          blockedBytes = next.bytes
          output.once('drain', () => {
            pendingBytes -= blockedBytes
            blockedBytes = 0
            blocked = false
            flush()
          })
        }
      } catch {
        fail()
      }
    }
  }
  output.once('error', fail)
  return (message: object): void => {
    if (stopped) {
      return
    }
    const line = `${JSON.stringify(message)}\n`
    const bytes = Buffer.byteLength(line)
    if (pendingBytes + bytes > MAX_PROTOCOL_QUEUE_BYTES) {
      // Why: parent stalls must become a recoverable watcher exit, never
      // unbounded memory growth in the managed Linux host.
      fail()
      return
    }
    pendingBytes += bytes
    queued.push({ line, bytes })
    flush()
  }
}
