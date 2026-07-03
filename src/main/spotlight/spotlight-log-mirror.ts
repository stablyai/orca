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

type LogCapture = {
  repoId: string
  ptyId: string
  logPath: string
  unsubscribe: () => void
  pending: string
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

function scheduleFlush(capture: LogCapture): void {
  if (capture.flushTimer || capture.flushing) {
    return
  }
  capture.flushTimer = setTimeout(() => {
    capture.flushTimer = null
    void flushCapture(capture)
  }, FLUSH_DEBOUNCE_MS)
}

async function flushCapture(capture: LogCapture): Promise<void> {
  if (capture.flushing || capture.stopped) {
    return
  }
  const chunk = stripTerminalSequences(capture.pending)
  capture.pending = ''
  if (!chunk) {
    return
  }
  capture.flushing = true
  try {
    let handle = capture.handle
    if (!handle) {
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
    capture.bytesOnDisk += Buffer.byteLength(chunk)
    if (capture.bytesOnDisk > MAX_LOG_BYTES) {
      await trimLog(capture)
    }
  } catch {
    // Non-fatal: the log dir may have been removed mid-session. Re-queue the
    // chunk (re-stripping plain text is a no-op) so a transient write error
    // doesn't drop server output, and drop the stale handle to force a reopen.
    capture.pending = chunk + capture.pending
    await capture.handle?.close().catch(() => {})
    capture.handle = null
  } finally {
    capture.flushing = false
    // Output that arrived while flushing still needs to land.
    if (capture.pending && !capture.stopped) {
      scheduleFlush(capture)
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
    flushTimer: null,
    flushing: false,
    handle: null,
    bytesOnDisk,
    triggerWatcher: null,
    restartInFlight: false,
    stopped: false
  }
  subscribeCapture(capture)
  capture.triggerWatcher = watchRestartTrigger(path.dirname(logPath), () =>
    restartSpotlightServer(capture.repoId)
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
