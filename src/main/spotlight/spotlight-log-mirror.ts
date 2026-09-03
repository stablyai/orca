// Mirrors the Spotlight terminal's PTY output into <repoRoot>/.orca/spotlight.log
// so agents running in any worktree can read the dev server's logs (the server
// runs once, at the repo root, inside the Spotlight terminal tab).
import type { FSWatcher } from 'node:fs'
import {
  appendFile,
  mkdir,
  open,
  readFile,
  stat,
  writeFile,
  type FileHandle
} from 'node:fs/promises'
import path from 'node:path'
import { SPOTLIGHT_LOG_RELATIVE_PATH } from '../../shared/spotlight'
import { stripTerminalSequences } from '../../shared/terminal-escape-stripping'
import { gitExecFileAsync } from '../git/runner'
import { getLocalPtyProvider, onLocalPtyProviderChanged } from '../ipc/pty'
import { sendServerRestart, watchRestartTrigger } from './spotlight-restart-trigger'

// Keep the log useful for `tail`/`grep` without growing unbounded: once it
// passes MAX, rewrite it down to the most recent TRIM bytes.
const MAX_LOG_BYTES = 4 * 1024 * 1024
const TRIM_LOG_BYTES = 1 * 1024 * 1024

function spotlightLogPathFor(rootPath: string): string {
  return path.join(rootPath, ...SPOTLIGHT_LOG_RELATIVE_PATH.split('/'))
}
// Coalesce bursty PTY output into one flush so a chatty server doesn't cause
// an fs write + regex pass per chunk.
const FLUSH_DEBOUNCE_MS = 60
// Back off (up to this ceiling) when writes keep failing, so a permanently
// broken log (dir deleted, disk full) doesn't retry at the debounce rate.
const MAX_FLUSH_BACKOFF_MS = 5000
// Bound the in-memory buffer: if writes keep failing while the server keeps
// printing, drop the oldest buffered output instead of growing without limit.
const MAX_PENDING_BYTES = 2 * 1024 * 1024

function flushBackoffMs(failures: number): number {
  return Math.min(FLUSH_DEBOUNCE_MS * 2 ** Math.min(failures, 10), MAX_FLUSH_BACKOFF_MS)
}

function capPendingBytes(text: string): string {
  const buf = Buffer.from(text, 'utf-8')
  if (buf.length <= MAX_PENDING_BYTES) {
    return text
  }
  // Keep the newest MAX_PENDING_BYTES *bytes* (slicing by string .length would
  // undercount multibyte output — e.g. CJK/emoji — and never actually shrink
  // the buffer, defeating the bound). A partial leading multibyte char at the
  // cut decodes to U+FFFD, which is harmless in a log.
  const tail = buf.subarray(buf.length - MAX_PENDING_BYTES).toString('utf-8')
  return `\n[Orca Spotlight: log write buffer overflowed — older output dropped]\n${tail}`
}

type LogCapture = {
  repoId: string
  ptyId: string
  logPath: string
  unsubscribe: () => void
  /** Raw, unstripped PTY data awaiting the next flush. */
  pending: string
  /** Already-stripped bytes a prior write failed to flush — retried verbatim
   *  (never re-stripped, which was quadratic under a persistent write error). */
  writeBacklog: string
  /** Consecutive write failures, for exponential backoff. */
  flushFailures: number
  flushTimer: ReturnType<typeof setTimeout> | null
  flushing: boolean
  /** Persistent append handle for the capture's lifetime (avoids open/close per flush). */
  handle: FileHandle | null
  bytesOnDisk: number
  /** Watches .orca/ for the agent-written restart trigger file. */
  triggerWatcher: FSWatcher | null
  restartInFlight: boolean
  stopped: boolean
}

const capturesByRepoId = new Map<string, LogCapture>()
let providerRebindInstalled = false

function subscribeCapture(capture: LogCapture): void {
  capture.unsubscribe = getLocalPtyProvider().onData((payload: { id: string; data: string }) => {
    if (payload.id !== capture.ptyId) {
      return
    }
    capture.pending += payload.data
    scheduleFlush(capture)
  })
}

function scheduleFlush(capture: LogCapture, delayMs = FLUSH_DEBOUNCE_MS): void {
  if (capture.flushTimer || capture.flushing) {
    return
  }
  capture.flushTimer = setTimeout(() => {
    capture.flushTimer = null
    void flushCapture(capture)
  }, delayMs)
}

async function flushCapture(capture: LogCapture): Promise<void> {
  if (capture.flushing || capture.stopped) {
    return
  }
  // Strip freshly-arrived raw data ONCE, then prepend any already-stripped
  // backlog from a failed write. The backlog is never re-stripped — doing so on
  // every retry was O(n²) while the buffer grew.
  const fresh = stripTerminalSequences(capture.pending)
  capture.pending = ''
  const chunk = capture.writeBacklog + fresh
  capture.writeBacklog = ''
  if (!chunk) {
    return
  }
  capture.flushing = true
  let failed = false
  try {
    let handle = capture.handle
    if (!handle) {
      // Recreate the dir in case .orca/ was removed mid-session, so a transient
      // deletion self-heals instead of failing every flush forever.
      await mkdir(path.dirname(capture.logPath), { recursive: true }).catch(() => {})
      handle = await open(capture.logPath, 'a')
      // Teardown could have run while `open` was pending — it saw a null
      // handle and couldn't close this one. Close it here so the fd doesn't
      // leak, and don't write to a torn-down capture.
      if (capture.stopped) {
        await handle.close().catch(() => {})
        return
      }
      capture.handle = handle
    }
    await handle.write(chunk)
    capture.flushFailures = 0
    capture.bytesOnDisk += Buffer.byteLength(chunk)
    if (capture.bytesOnDisk > MAX_LOG_BYTES) {
      // Trim in its OWN scope: a trim failure must not requeue the chunk we just
      // wrote (that would duplicate it on the next flush).
      try {
        await trimLog(capture)
      } catch {
        // Non-fatal: the log stays readable, just above the size cap.
      }
    }
  } catch {
    // The write itself failed (dir removed, disk full, bad fd). Keep the
    // already-stripped chunk to retry verbatim, drop the stale handle to force
    // a reopen + mkdir, and back off so a persistent failure doesn't spin.
    failed = true
    capture.flushFailures += 1
    capture.writeBacklog = capPendingBytes(chunk)
    await capture.handle?.close().catch(() => {})
    capture.handle = null
  } finally {
    capture.flushing = false
    // Output that arrived while flushing (or the requeued backlog) still needs
    // to land; back off the retry when the last write failed.
    if (!capture.stopped && (capture.pending || capture.writeBacklog)) {
      scheduleFlush(capture, failed ? flushBackoffMs(capture.flushFailures) : FLUSH_DEBOUNCE_MS)
    }
  }
}

/** Trim by copying only the last TRIM_LOG_BYTES via a positional read — never
 *  loads the whole (multi-MB) file into memory on the main process. */
async function trimLog(capture: LogCapture): Promise<void> {
  await capture.handle?.close().catch(() => {})
  capture.handle = null
  let tail = ''
  const reader = await open(capture.logPath, 'r')
  try {
    const { size } = await reader.stat()
    const start = Math.max(0, size - TRIM_LOG_BYTES)
    const length = size - start
    const buffer = Buffer.alloc(length)
    await reader.read(buffer, 0, length, start)
    tail = buffer.toString('utf-8')
  } finally {
    await reader.close().catch(() => {})
  }
  const firstNewline = tail.indexOf('\n')
  const body = firstNewline === -1 ? tail : tail.slice(firstNewline + 1)
  await writeFile(capture.logPath, `[log trimmed by Orca]\n${body}`, 'utf-8')
  capture.bytesOnDisk = Buffer.byteLength(`[log trimmed by Orca]\n${body}`)
}

/** Make sure `.orca/` is ignored in the root checkout without touching the
 *  repo's tracked .gitignore — `.git/info/exclude` is local-only by design. */
async function ensureOrcaDirExcluded(rootPath: string): Promise<void> {
  const { stdout } = await gitExecFileAsync(['rev-parse', '--git-path', 'info/exclude'], {
    cwd: rootPath
  })
  const excludePath = path.resolve(rootPath, stdout.trim())
  let current = ''
  try {
    current = await readFile(excludePath, 'utf-8')
  } catch {
    // Missing file is fine — created below.
  }
  if (current.split(/\r?\n/).some((line) => line.trim() === '.orca/')) {
    return
  }
  await mkdir(path.dirname(excludePath), { recursive: true })
  const separator = current.length > 0 && !current.endsWith('\n') ? '\n' : ''
  await writeFile(excludePath, `${current}${separator}# Orca Spotlight logs\n.orca/\n`, 'utf-8')
}

export async function startSpotlightLogCapture(args: {
  repoId: string
  ptyId: string
  rootPath: string
}): Promise<void> {
  // Captured before the async setup below so watchRestartTrigger can tell a
  // stale prior-session trigger from one written during this setup gap.
  const captureStartedAtMs = Date.now()
  const existing = capturesByRepoId.get(args.repoId)
  if (existing?.ptyId === args.ptyId) {
    return
  }
  // Fully tear down the previous capture (listener, flush handle, AND the
  // trigger watcher) before replacing it, or PTY respawns leak fs watchers.
  if (existing) {
    teardownCapture(existing)
  }

  const logPath = spotlightLogPathFor(args.rootPath)
  await mkdir(path.dirname(logPath), { recursive: true })
  await ensureOrcaDirExcluded(args.rootPath).catch(() => {
    // Best-effort: without the exclude the log shows up as untracked in the
    // root, which is cosmetic — never block capture on it.
  })
  await appendFile(
    logPath,
    `\n──── Orca Spotlight terminal capture started ${new Date().toISOString()} ────\n`,
    'utf-8'
  ).catch(() => {})
  // Seed byte count from the actual on-disk size (after the marker) so the trim
  // threshold is measured across sessions, not reset to 0 each start.
  let bytesOnDisk = 0
  try {
    bytesOnDisk = (await stat(logPath)).size
  } catch {
    // No file yet.
  }

  const capture: LogCapture = {
    repoId: args.repoId,
    ptyId: args.ptyId,
    logPath,
    unsubscribe: () => {},
    pending: '',
    writeBacklog: '',
    flushFailures: 0,
    flushTimer: null,
    flushing: false,
    handle: null,
    bytesOnDisk,
    triggerWatcher: null,
    restartInFlight: false,
    stopped: false
  }
  subscribeCapture(capture)
  capture.triggerWatcher = watchRestartTrigger(
    path.dirname(logPath),
    () => restartSpotlightServer(capture.repoId),
    captureStartedAtMs
  )
  capturesByRepoId.set(args.repoId, capture)

  if (!providerRebindInstalled) {
    providerRebindInstalled = true
    // A daemon swap replaces the provider instance; re-subscribe every live
    // capture on the new one so daemon restarts don't silently end mirroring.
    onLocalPtyProviderChanged(() => {
      for (const live of capturesByRepoId.values()) {
        live.unsubscribe()
        subscribeCapture(live)
      }
    })
  }
}

/** Restart the repo's Spotlight server (interrupt + history recall) and log the
 *  attempt. Driven by the .orca/spotlight-restart file watcher below. */
function restartSpotlightServer(repoId: string): boolean {
  const capture = capturesByRepoId.get(repoId)
  if (!capture) {
    return false
  }
  const started = sendServerRestart(capture)
  if (started) {
    void appendSpotlightLogNote(
      path.dirname(path.dirname(capture.logPath)),
      'Server restart requested from a workspace (interrupt + history recall sent)'
    )
  }
  return started
}

/** Write a marker line into the log (holder switches, spotlight off) so agents
 *  reading it know WHOSE workspace the surrounding output belongs to. */
export async function appendSpotlightLogNote(rootPath: string, note: string): Promise<void> {
  try {
    const logPath = spotlightLogPathFor(rootPath)
    await mkdir(path.dirname(logPath), { recursive: true })
    await appendFile(logPath, `\n──── ${note} (${new Date().toISOString()}) ────\n`, 'utf-8')
  } catch {
    // Best-effort marker; never block a spotlight operation on it.
  }
}

function teardownCapture(capture: LogCapture): void {
  capture.stopped = true
  capture.unsubscribe()
  capture.triggerWatcher?.close()
  capture.triggerWatcher = null
  if (capture.flushTimer) {
    clearTimeout(capture.flushTimer)
    capture.flushTimer = null
  }
  void capture.handle?.close().catch(() => {})
  capture.handle = null
}

export function stopSpotlightLogCapture(args: { repoId: string; ptyId?: string }): void {
  const capture = capturesByRepoId.get(args.repoId)
  if (!capture || (args.ptyId !== undefined && capture.ptyId !== args.ptyId)) {
    return
  }
  teardownCapture(capture)
  capturesByRepoId.delete(args.repoId)
}
