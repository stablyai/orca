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
import {
  canonicalOfficeDocumentPath,
  OfficeDocumentPathError,
  officeSessionKey
} from './office-document-path'
import {
  classifyOfficecliRun,
  classifyOfficeThrown,
  parseAlreadyWatchedPort
} from './office-error-codes'
import { allocateLoopbackPort, waitForWatchPort } from './office-watch-port'
import { officecliWatchStartArgs, officecliWatchStopArgs } from './officecli-argv'
import { NATIVE_OFFICECLI_LANE, officecliLaneKey, type OfficecliLane } from './officecli-lane'
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

export async function startOfficeWatch(
  documentPath: string,
  lane: OfficecliLane = NATIVE_OFFICECLI_LANE
): Promise<OfficeWatchOutcome> {
  if (!isOfficeRenderable(documentPath)) {
    return officeFailure('OFFICECLI_UNSUPPORTED_FORMAT')
  }
  let canonicalPath: string
  try {
    canonicalPath = await canonicalOfficeDocumentPath(documentPath, lane)
  } catch (error) {
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
 * Stop a session. `unwatch` first because it is the tool's own cooperative shutdown and also
 * clears its registry entry; the process-tree kill is the authority, because we own the child and
 * a cooperative stop that silently does nothing is exactly what leaks a port.
 */
export async function stopOfficeWatch(
  documentPath: string,
  lane: OfficecliLane = NATIVE_OFFICECLI_LANE
): Promise<OfficeAckOutcome> {
  let canonicalPath: string
  try {
    canonicalPath = await canonicalOfficeDocumentPath(documentPath, lane)
  } catch {
    // A document that no longer resolves cannot be canonicalised, but its session still has to go.
    canonicalPath = documentPath
  }
  const key = officeWatchSessionKeyFor(lane, canonicalPath)
  const session = sessions.get(key)
  sessions.delete(key)
  try {
    await runOfficecli(officecliWatchStopArgs(session?.documentPath ?? canonicalPath), {
      lane,
      timeoutMs: STOP_TIMEOUT_MS,
      maxOutputBytes: 16 * 1024
    })
  } catch {
    // Nothing to report: the kill below is what the caller is promised, and a host with no binary
    // left has no watch server either.
  }
  if (session?.child) {
    await terminateChild(session.child)
  }
  return { ok: true }
}

/** Teardown for a whole host going away, and for app quit. */
export async function stopAllOfficeWatches(lane?: OfficecliLane): Promise<void> {
  const laneKey = lane ? officecliLaneKey(lane) : null
  const doomed = [...sessions.values()].filter(
    (session) => laneKey === null || officecliLaneKey(session.lane) === laneKey
  )
  await Promise.all(
    doomed.map(async (session) => {
      sessions.delete(session.key)
      if (session.child) {
        await terminateChild(session.child)
      }
    })
  )
}

/** Sweep: stop every session whose document is no longer named by a live surface. */
export async function retainOfficeWatches(liveKeys: ReadonlySet<string>): Promise<void> {
  await Promise.all(
    [...sessions.values()]
      .filter((session) => !liveKeys.has(session.key))
      .map((session) => stopOfficeWatch(session.documentPath, session.lane))
  )
}
