/**
 * WSL-native file watcher for WSL paths.
 *
 * Why: polling \\wsl.localhost from Windows keeps waking the distro after
 * `wsl --shutdown`, which can make WSL look wedged. Keep the polling process
 * inside the distro so shutdown kills it instead of Orca restarting WSL.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { WebContents } from 'electron'
import type { Event as WatcherEvent } from '@parcel/watcher'
import { queueWatcherEvents } from './filesystem-watcher-event-batch'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { createWslWatcherProcessExit, createWslWatcherStartup } from './wsl-watcher-process-exit'
import { reserveWatcherChild, WatcherChildCapacityError } from './parcel-watcher-child-registry'

export type WatcherSubscription = {
  unsubscribe(): Promise<void>
}

type DebouncedBatch = {
  events: WatcherEvent[]
  overflowed: boolean
  timer: ReturnType<typeof setTimeout> | null
  firstEventAt: number
}

export type WatchedRoot = {
  subscription: WatcherSubscription
  listeners: Map<number, WebContents>
  batch: DebouncedBatch
  rootPath?: string
}

export type WslWatcherDeps = {
  ignoreDirs: string[]
  scheduleBatchFlush: (rootKey: string, root: WatchedRoot) => void
  watchedRoots: Map<string, WatchedRoot>
}

const POLL_INTERVAL_SECONDS = 2
const STARTUP_TIMEOUT_MS = 10_000
const [SNAPSHOT_START, SNAPSHOT_END] = ['\x1e', '\x1f']
const MAX_STREAM_BUFFER_CHARS = 10 * 1024 * 1024

type WslSnapshotEntry = {
  path: string
  type: string
  mtime: string
}

type WslSnapshot = Map<string, WslSnapshotEntry>

function toWslUncPath(linuxPath: string, distro: string): string {
  return `\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//g, '\\')}`
}

function quoteSafeFindName(name: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error(`Unsupported WSL watcher ignore name: ${name}`)
  }
  return `'${name}'`
}

function buildPruneExpression(ignoreDirs: readonly string[]): string {
  if (ignoreDirs.length === 0) {
    return ''
  }
  const names = ignoreDirs.map((name) => `-name ${quoteSafeFindName(name)}`).join(' -o ')
  return `\\( -type d \\( ${names} \\) -prune \\) -o`
}

function buildSnapshotScript(ignoreDirs: readonly string[]): string {
  const prune = buildPruneExpression(ignoreDirs)
  return [
    'set -efu',
    'root=$1',
    'while :; do',
    "  printf '\\036'",
    '  if [ -d "$root" ]; then',
    `    find "$root" -mindepth 1 -maxdepth 2 ${prune} -printf '%y\\t%T@\\t%p\\0' 2>/dev/null || true`,
    '  fi',
    "  printf '\\037'",
    `  sleep ${POLL_INTERVAL_SECONDS} || exit 0`,
    'done'
  ].join('\n')
}

function parseSnapshotFrame(frame: string, distro: string): WslSnapshot {
  const snapshot: WslSnapshot = new Map()
  for (const rawEntry of frame.split('\0')) {
    if (!rawEntry) {
      continue
    }
    const firstTab = rawEntry.indexOf('\t')
    const secondTab = firstTab === -1 ? -1 : rawEntry.indexOf('\t', firstTab + 1)
    if (firstTab <= 0 || secondTab <= firstTab + 1) {
      continue
    }
    const linuxPath = rawEntry.slice(secondTab + 1)
    if (!linuxPath.startsWith('/')) {
      continue
    }
    const entry: WslSnapshotEntry = {
      type: rawEntry.slice(0, firstTab),
      mtime: rawEntry.slice(firstTab + 1, secondTab),
      path: toWslUncPath(linuxPath, distro)
    }
    snapshot.set(entry.path, entry)
  }
  return snapshot
}

function diffSnapshots(prev: WslSnapshot, next: WslSnapshot): WatcherEvent[] {
  const events: WatcherEvent[] = []

  for (const [entryPath, nextEntry] of next) {
    const prevEntry = prev.get(entryPath)
    if (!prevEntry) {
      events.push({ type: 'create', path: entryPath } as WatcherEvent)
      continue
    }
    if (prevEntry.type !== nextEntry.type) {
      events.push({ type: 'delete', path: entryPath } as WatcherEvent)
      events.push({ type: 'create', path: entryPath } as WatcherEvent)
      continue
    }
    if (prevEntry.mtime !== nextEntry.mtime) {
      events.push({ type: 'update', path: entryPath } as WatcherEvent)
    }
  }

  for (const entryPath of prev.keys()) {
    if (!next.has(entryPath)) {
      events.push({ type: 'delete', path: entryPath } as WatcherEvent)
    }
  }

  return events
}

function markOverflowWithoutUncStat(root: WatchedRoot): void {
  if (root.batch.timer) {
    clearTimeout(root.batch.timer)
    root.batch.timer = null
  }
  root.batch.events = []
  root.batch.overflowed = true
}

export async function createWslWatcher(
  rootKey: string,
  worktreePath: string,
  deps: WslWatcherDeps,
  signal?: AbortSignal
): Promise<WatchedRoot> {
  // Why: honor local-install cancellation before spawning a WSL snapshot process.
  if (signal?.aborted) {
    throw new DOMException('WSL watcher subscription aborted', 'AbortError')
  }

  const wsl = parseWslUncPath(worktreePath)
  if (!wsl) {
    throw new Error(`Not a WSL path: ${worktreePath}`)
  }
  const distro = wsl.distro
  const linuxPath = wsl.linuxPath

  const root: WatchedRoot = {
    subscription: null!,
    listeners: new Map(),
    batch: { events: [], overflowed: false, timer: null, firstEventAt: 0 },
    rootPath: worktreePath
  }

  let disposed = false
  let prevSnapshot: WslSnapshot | null = null
  let stopped = false
  let streamBuffer = ''
  const stdoutDecoder = new StringDecoder('utf8')
  const stderrDecoder = new StringDecoder('utf8')
  let stderrTail = ''

  const startup = createWslWatcherStartup()

  function signalWatcherStopped(): void {
    if (stopped) {
      return
    }
    if (!prevSnapshot) {
      return
    }
    stopped = true
    markOverflowWithoutUncStat(root)
    deps.scheduleBatchFlush(rootKey, root)
    deps.watchedRoots.delete(rootKey)
  }

  function ingestFrame(frame: string): void {
    const nextSnapshot = parseSnapshotFrame(frame, distro)
    if (!prevSnapshot) {
      prevSnapshot = nextSnapshot
      startup.settle()
      return
    }
    const events = diffSnapshots(prevSnapshot, nextSnapshot)
    prevSnapshot = nextSnapshot

    if (events.length > 0) {
      queueWatcherEvents(root.batch, events)
      deps.scheduleBatchFlush(rootKey, root)
    }
  }

  function drainFrames(): void {
    while (true) {
      const start = streamBuffer.indexOf(SNAPSHOT_START)
      if (start === -1) {
        streamBuffer = streamBuffer.slice(-1)
        return
      }
      if (start > 0) {
        streamBuffer = streamBuffer.slice(start)
      }
      const end = streamBuffer.indexOf(SNAPSHOT_END, 1)
      if (end === -1) {
        if (streamBuffer.length > MAX_STREAM_BUFFER_CHARS) {
          streamBuffer = ''
          markOverflowWithoutUncStat(root)
          deps.scheduleBatchFlush(rootKey, root)
        }
        return
      }
      const frame = streamBuffer.slice(1, end)
      streamBuffer = streamBuffer.slice(end + 1)
      ingestFrame(frame)
    }
  }

  let child: ChildProcessWithoutNullStreams
  const releaseChildReservation = reserveWatcherChild()
  if (!releaseChildReservation) {
    throw new WatcherChildCapacityError()
  }
  try {
    child = spawn('wsl.exe', ['-d', distro, '--', 'sh', '-s', '--', linuxPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
  } catch (error) {
    releaseChildReservation()
    throw error instanceof Error ? error : new Error(String(error))
  }

  // Why: the physical-exit owner releases the shared process reservation on
  // exactly the same close/error proof that settles destructive cleanup.
  const processExit = createWslWatcherProcessExit(child, worktreePath, releaseChildReservation)

  const onAbort = (): void => {
    startup.settle(new DOMException('WSL watcher subscription aborted', 'AbortError'))
    processExit.requestStopBestEffort()
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  const startupTimer = setTimeout(() => {
    startup.settle(new Error(`Timed out starting WSL watcher for ${worktreePath}`))
    processExit.requestStopBestEffort()
  }, STARTUP_TIMEOUT_MS)

  child.stdin.on('error', (error) => {
    // Why: WSL can exit before reading the script; handle EPIPE here so the
    // startup failure rejects the watcher instead of crashing on a stream error.
    if (!startup.settled) {
      startup.settle(error)
    }
  })

  child.stdout.on('data', (chunk: Buffer) => {
    if (disposed) {
      return
    }
    streamBuffer += stdoutDecoder.write(chunk)
    drainFrames()
  })

  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + stderrDecoder.write(chunk)).slice(-4096)
  })

  child.stdout.on('error', (error) => {
    if (!startup.settled) {
      startup.settle(error)
      return
    }
    if (!disposed) {
      signalWatcherStopped()
    }
  })

  child.stderr.on('error', () => {
    // Ignore diagnostic stream failures; stdout/close determine watcher state.
  })

  child.once('error', (error) => {
    // Why: a child that never acquired a pid has no OS owner to await. Kill
    // errors for an already-spawned child still require the close event.
    if (child.pid === undefined) {
      processExit.markPhysicalExit()
    }
    if (!startup.settled) {
      startup.settle(error)
      return
    }
    if (!disposed) {
      signalWatcherStopped()
    }
  })

  child.once('close', (code, signal) => {
    processExit.markPhysicalExit()
    if (!startup.settled) {
      const suffix = stderrTail.trim() ? `: ${stderrTail.trim()}` : ''
      startup.settle(
        new Error(`WSL watcher exited before first snapshot (${code ?? signal})${suffix}`)
      )
      return
    }
    if (!disposed) {
      signalWatcherStopped()
    }
  })

  try {
    child.stdin.end(buildSnapshotScript(deps.ignoreDirs))
    await startup.ready
  } catch (error) {
    // Why: cancellation is part of destructive removal. Do not let the failed
    // install disappear from ownership until WSL confirms the child exited.
    startup.settle(error instanceof Error ? error : new Error(String(error)))
    await startup.ready.catch(() => undefined)
    await processExit.stopAndWait()
    throw error
  } finally {
    clearTimeout(startupTimer)
    signal?.removeEventListener('abort', onAbort)
  }

  root.subscription = {
    unsubscribe: async () => {
      disposed = true
      await processExit.stopAndWait()
    }
  }

  return root
}
