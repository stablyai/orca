import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { AiVaultScanIssue, AiVaultSession } from '../../shared/ai-vault-types'
import type {
  OpenCodeTranscriptForwardPage,
  OpenCodeTranscriptPage,
  OpenCodeTranscriptSignal
} from '../native-chat/transcript-opencode-sqlite-query'
import type { SessionFileCandidate } from './session-scanner-types'
import { OpenCodeSqliteWorkerClient } from './session-scanner-opencode-sqlite-worker-client'
import {
  dispatchOpenCodeNativeChatPage,
  dispatchOpenCodeNativeChatPageAfter,
  dispatchOpenCodeNativeChatSignal
} from './session-scanner-opencode-sqlite-native-chat-dispatch'

// Why: resolve the built worker entry + own the process-wide shared client so
// the client class stays free of Electron (require'd lazily here) and the
// scanner / native-chat call sites depend only on the routing functions below.

const WORKER_ENTRY_FILENAME = 'session-scanner-opencode-sqlite-worker-entry.js'

export function resolveOpenCodeSqliteWorkerEntryPath(
  runtimeDir = __dirname,
  pathExists: (path: string) => boolean = existsSync
): string {
  const candidates = [
    join(runtimeDir, WORKER_ENTRY_FILENAME),
    // Rollup factors this launcher into out/main/chunks when the outer scanner
    // worker and main entry both import it; worker entries remain in out/main.
    join(runtimeDir, '..', WORKER_ENTRY_FILENAME)
  ]
  return candidates.find(pathExists) ?? candidates[0]!
}

function defaultWorkerFactory(): Worker {
  const workerPath = resolveOpenCodeSqliteWorkerEntryPath()
  // Why: a missing built entry must throw synchronously so the client can fail
  // closed before it waits on a worker that can never post a result.
  if (!existsSync(workerPath)) {
    throw new Error(`OpenCode SQLite worker entry not found: ${workerPath}`)
  }
  return new Worker(workerPath)
}

let sharedClient: OpenCodeSqliteWorkerClient | null = null

function getSharedClient(): OpenCodeSqliteWorkerClient {
  sharedClient ??= new OpenCodeSqliteWorkerClient({ workerFactory: defaultWorkerFactory })
  return sharedClient
}

/**
 * List OpenCode SQLite session candidates through the shared worker client.
 * @param args.dbPaths - Absolute paths to opencode.db files to scan.
 * @param args.limit - Maximum number of sessions to return per database.
 * @param args.issues - Collected scan issues to append errors to.
 * @returns Synthetic candidates sorted by effective recency.
 */
export function listOpenCodeSqliteSessionsViaWorker(args: {
  dbPaths: readonly string[]
  limit: number
  issues: AiVaultScanIssue[]
}): Promise<SessionFileCandidate[]> {
  return getSharedClient().list(args)
}

/**
 * Parse one OpenCode SQLite session through the shared worker client.
 * @param args.dbPath - Absolute path to the opencode.db file.
 * @param args.sessionId - Primary key in the `session` table.
 * @param args.platform - Platform used for resume-command generation.
 * @returns The parsed session, or `null` when it does not exist.
 */
export function parseOpenCodeSqliteSessionViaWorker(args: {
  dbPath: string
  sessionId: string
  platform: NodeJS.Platform
}): Promise<AiVaultSession | null> {
  return getSharedClient().parse(args)
}

/**
 * Read one native-chat transcript page through the shared worker client.
 * @returns The page, or `null` when the session row does not exist.
 */
export function readOpenCodeTranscriptPageViaWorker(args: {
  dbPath: string
  sessionId: string
  limit: number
  beforeMessageRowId?: number
}): Promise<OpenCodeTranscriptPage | null> {
  return dispatchOpenCodeNativeChatPage(getSharedClient(), args)
}

/**
 * Read the cheap change signal for one session through the shared worker client.
 * @returns The signal, or `null` when the session row does not exist.
 */
export function readOpenCodeTranscriptSignalViaWorker(args: {
  dbPath: string
  sessionId: string
}): Promise<OpenCodeTranscriptSignal | null> {
  return dispatchOpenCodeNativeChatSignal(getSharedClient(), args)
}

/**
 * Read the oldest-first messages strictly NEWER than a rowid cursor through the
 * shared worker client — the orchestration worker-read's forward continuation.
 * @returns The page, or `null` when the session row does not exist.
 */
export function readOpenCodeTranscriptPageAfterViaWorker(args: {
  dbPath: string
  sessionId: string
  afterMessageRowId: number
  limit: number
  upToMessageRowId?: number
}): Promise<OpenCodeTranscriptForwardPage | null> {
  return dispatchOpenCodeNativeChatPageAfter(getSharedClient(), args)
}
