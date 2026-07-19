import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { AiVaultScanIssue, AiVaultSession } from '../../shared/ai-vault-types'
import type { SessionFileCandidate } from './session-scanner-types'
import { OpenCodeSqliteWorkerClient } from './session-scanner-opencode-sqlite-worker-client'

// Why: resolve the built worker entry + own the process-wide shared client so
// the client class stays free of Electron (require'd lazily here) and the
// scanner call sites depend only on the two routing functions below.

function resolveWorkerEntryPath(): string {
  let app: { isPackaged: boolean } | null = null
  try {
    app = require('electron').app ?? null
  } catch {
    app = null
  }
  if (app?.isPackaged) {
    return join(
      process.resourcesPath,
      'app.asar',
      'out',
      'main',
      'session-scanner-opencode-sqlite-worker-entry.js'
    )
  }
  return join(__dirname, 'session-scanner-opencode-sqlite-worker-entry.js')
}

function defaultWorkerFactory(): Worker {
  const workerPath = resolveWorkerEntryPath()
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
