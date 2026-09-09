/**
 * Watch sessions: one live `officecli watch` server per (execution host, canonical document path).
 *
 * A leaked watch process holds a port and a file on somebody's machine, so every exit path tears
 * down: tab close, workspace close, host disconnect, app quit, and the sweep a caller drives from
 * whatever owns tab lifetime. Loss of contact with a session is `unverifiable`, never `exited` —
 * see docs/reference/ssh-execution-boundary.md.
 */
import {
  forceTerminateProcessTree,
  signalProcessTree
} from '../../shared/child-process/process-tree-termination'
import type { ChildProcessHandle } from '../../shared/child-process/run-process'
import {
  OFFICE_WATCH_READY_POLL_INTERVAL_MS,
  OFFICE_WATCH_READY_TIMEOUT_MS,
  officeFailure,
  type OfficeAckOutcome,
  type OfficeWatchOutcome
} from '../../shared/office-preview-contracts'
import { isOfficeRenderable } from '../../shared/office-file-extensions'
import { joinOfficeRelativePath } from '../../shared/office-preview-rpc'
import {
  OfficeDocumentOutsideWorkspaceError,
  OfficeDocumentPathError,
  officeSessionKey,
  resolveOfficeDocumentTarget
} from './office-document-path'
import {
  classifyOfficecliRun,
  classifyOfficeThrown,
  parseAlreadyWatchedPort
} from './office-error-codes'
import { allocateLoopbackPort, waitForWatchPort } from './office-watch-port'
import { officecliWatchStartArgs, officecliWatchStopArgs } from './officecli-argv'
import type { OfficeDocumentRef } from './office-local-execution'
import { officecliLaneKey, type OfficecliLane } from './officecli-lane'
import { runOfficecli, spawnOfficecli } from './officecli-invocation'

/** The allocate→bind window is genuinely racy; three attempts is the documented budget. */
const PORT_ATTEMPTS = 3
const STOP_TIMEOUT_MS = 10_000

type WatchSession = {
  key: string
  documentPath: string
  lane: OfficecliLane
  port: number
  /** Absent for an adopted server: it belongs to a process we did not start and must not kill. */
  child: ChildProcessHandle | null
  exited: boolean
}

const sessions = new Map<string, WatchSession>()
/** Serialises concurrent starts for one document, so two tabs cannot race into two watch servers. */
const starting = new Map<string, Promise<OfficeWatchOutcome>>()

export function officeWatchSessionPort(key: string): number | null {
  const session = sessions.get(key)
  return session && !session.exited ? session.port : null
}

export function officeWatchSessionKeyFor(lane: OfficecliLane, canonicalPath: string): string {
  return officeSessionKey(officecliLaneKey(lane), canonicalPath)
}

/** Read side for the refresh path, which needs the port and the exact path the server was given. */
export function findOfficeWatchSession(
  lane: OfficecliLane,
  canonicalPath: string
): { port: number; documentPath: string } | null {
  const session = sessions.get(officeWatchSessionKeyFor(lane, canonicalPath))
  return session && !session.exited
    ? { port: session.port, documentPath: session.documentPath }
    : null
}

async function startOnPort(
  canonicalPath: string,
  lane: OfficecliLane,
  key: string
): Promise<OfficeWatchOutcome | 'retry'> {
  const port = await allocateLoopbackPort()
  let stderr = ''
  let stdout = ''
  let exited = false
  const child = await spawnOfficecli(officecliWatchStartArgs(canonicalPath, port), {
    lane,
    onTerminated: () => {
      exited = true
      const session = sessions.get(key)
      if (session?.child === child) {
        session.exited = true
      }
    }
  })
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8').slice(0, 4_000)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8').slice(0, 4_000)
  })
  child.once('error', () => {
    exited = true
  })
  const readiness = await waitForWatchPort(port, {
    intervalMs: OFFICE_WATCH_READY_POLL_INTERVAL_MS,
    timeoutMs: OFFICE_WATCH_READY_TIMEOUT_MS,
    isAlive: () => !exited
  })
  if (readiness === 'ready') {
    sessions.set(key, { key, documentPath: canonicalPath, lane, port, child, exited: false })
    return { ok: true, port, adopted: false }
  }
  await terminateChild(child)
  const combined = `${stdout}\n${stderr}`
  const adoptable = parseAlreadyWatchedPort(combined)
  if (adoptable !== null) {
    // The tool refused because a server is already serving this document. Adopt it rather than
    // asking the reader to hunt down a process: it is the same document at the same path, and
    // Orca losing track of its own session (a restart, a reconnect) is the common cause.
    sessions.set(key, {
      key,
      documentPath: canonicalPath,
      lane,
      port: adoptable,
      child: null,
      exited: false
    })
    return { ok: true, port: adoptable, adopted: true }
  }
  if (readiness === 'exited') {
    const failure = classifyOfficecliRun({ code: 1, stdout, stderr, timedOut: false }, 'watch')
    // A port taken between allocation and bind reads as an immediate exit with a bind error; that
    // one is worth another allocation, and only that one.
    return /address (already )?in use|EADDRINUSE/i.test(combined) ? 'retry' : failure
  }
  return officeFailure('OFFICECLI_PORT_TIMEOUT', stderr.trim() || undefined)
}

export async function startOfficeWatch(ref: OfficeDocumentRef): Promise<OfficeWatchOutcome> {
  const { lane } = ref
  if (!isOfficeRenderable(ref.relativePath)) {
    return officeFailure('OFFICECLI_UNSUPPORTED_FORMAT')
  }
  let canonicalPath: string
  try {
    canonicalPath = await resolveOfficeDocumentTarget(ref.workspaceRoot, ref.relativePath, lane)
  } catch (error) {
    if (error instanceof OfficeDocumentOutsideWorkspaceError) {
      return officeFailure('OFFICE_DOCUMENT_OUTSIDE_WORKSPACE', error.message)
    }
    return error instanceof OfficeDocumentPathError
      ? officeFailure('OFFICECLI_FILE_NOT_FOUND', error.message)
      : classifyOfficeThrown(error, 'watch')
  }
  const key = officeWatchSessionKeyFor(lane, canonicalPath)
  const live = sessions.get(key)
  if (live && !live.exited) {
    return { ok: true, port: live.port, adopted: live.child === null }
  }
  const inFlight = starting.get(key)
  if (inFlight) {
    return inFlight
  }
  const pending = (async (): Promise<OfficeWatchOutcome> => {
    try {
      for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
        const outcome = await startOnPort(canonicalPath, lane, key)
        if (outcome !== 'retry') {
          return outcome
        }
      }
      return officeFailure('OFFICECLI_WATCH_FAILED', 'Every allocated port was taken before bind')
    } catch (error) {
      return classifyOfficeThrown(error, 'watch')
    } finally {
      starting.delete(key)
    }
  })()
  starting.set(key, pending)
  return pending
}

async function terminateChild(child: ChildProcessHandle): Promise<void> {
  if (!(await signalProcessTree(child))) {
    await forceTerminateProcessTree(child)
  }
}

/**
 * Stop one already-registered session. `unwatch` first because it is the tool's own cooperative
 * shutdown and also clears its registry entry; the process-tree kill is the authority, because we
 * own the child and a cooperative stop that silently does nothing is exactly what leaks a port.
 */
async function stopWatchSession(session: WatchSession): Promise<void> {
  sessions.delete(session.key)
  try {
    await runOfficecli(officecliWatchStopArgs(session.documentPath), {
      lane: session.lane,
      timeoutMs: STOP_TIMEOUT_MS,
      maxOutputBytes: 16 * 1024
    })
  } catch {
    // Nothing to report: the kill below is what the caller is promised, and a host with no binary
    // left has no watch server either.
  }
  if (session.child) {
    await terminateChild(session.child)
  }
}

export async function stopOfficeWatch(ref: OfficeDocumentRef): Promise<OfficeAckOutcome> {
  const { lane } = ref
  let canonicalPath: string
  try {
    canonicalPath = await resolveOfficeDocumentTarget(ref.workspaceRoot, ref.relativePath, lane)
  } catch {
    // A document that no longer resolves — deleted while watched, most often — still has a session
    // that has to go. Fall back to the lane's own join rather than a hardcoded `/`: this string is
    // both the registry lookup and the argument handed to `officecli unwatch`, and a Windows path
    // spelled with a stray forward slash matches neither.
    canonicalPath =
      joinOfficeRelativePath(ref.workspaceRoot, ref.relativePath) ??
      `${ref.workspaceRoot}/${ref.relativePath}`
  }
  const session = sessions.get(officeWatchSessionKeyFor(lane, canonicalPath))
  if (session) {
    await stopWatchSession(session)
    return { ok: true }
  }
  // No session of ours, but the host may still hold one from a previous run of this client, and
  // `unwatch` is the only way to reach it.
  try {
    await runOfficecli(officecliWatchStopArgs(canonicalPath), {
      lane,
      timeoutMs: STOP_TIMEOUT_MS,
      maxOutputBytes: 16 * 1024
    })
  } catch {
    // Same reasoning as above.
  }
  return { ok: true }
}

/** Teardown for a whole host going away, and for app quit. */
export async function stopAllOfficeWatches(lane?: OfficecliLane): Promise<void> {
  const laneKey = lane ? officecliLaneKey(lane) : null
  const doomed = [...sessions.values()].filter(
    (session) => laneKey === null || officecliLaneKey(session.lane) === laneKey
  )
  await Promise.all(doomed.map((session) => stopWatchSession(session)))
}

/** Sweep: stop every session whose document is no longer named by a live surface. */
export async function retainOfficeWatches(liveKeys: ReadonlySet<string>): Promise<void> {
  await Promise.all(
    [...sessions.values()]
      .filter((session) => !liveKeys.has(session.key))
      .map((session) => stopWatchSession(session))
  )
}
