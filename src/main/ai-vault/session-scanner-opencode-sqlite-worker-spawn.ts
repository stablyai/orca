import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { AiVaultScanIssue, AiVaultSession } from '../../shared/ai-vault-types'
import { throwIfSignalAborted } from '../../shared/abort-signal-reason'
import type { SessionFileCandidate } from './session-scanner-types'
import type { OpenCodeSqliteCaptureValue } from './session-scanner-opencode-sqlite-worker-protocol'
import { OpenCodeSqliteWorkerClient } from './session-scanner-opencode-sqlite-worker-client'
import {
  buildOpenCodeSqliteCandidatePath,
  splitOpenCodeSqliteCandidate
} from './session-scanner-opencode-sqlite-paths'
import {
  mapOpenCodeWslSession,
  openCodeWslClient,
  openCodeWslPath
} from './session-scanner-opencode-wsl-client'

// Why: resolve the built worker entry + own the process-wide shared client so
// the client class stays free of Electron (require'd lazily here) and the
// scanner call sites depend only on the two routing functions below.

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
  signal?: AbortSignal
}): Promise<SessionFileCandidate[]> {
  return listForHost(args)
}

/**
 * List opencode2 session candidates (v2 channel-scoped DB schema) through the
 * shared worker client.
 */
export function listOpenCode2SqliteSessionsViaWorker(args: {
  dbPaths: readonly string[]
  limit: number
  issues: AiVaultScanIssue[]
  signal?: AbortSignal
}): Promise<SessionFileCandidate[]> {
  return listForHost({ ...args, agent: 'opencode2' })
}

/**
 * Parse one OpenCode SQLite session through the shared worker client.
 * @param args.dbPath - Absolute path to the opencode.db file.
 * @param args.sessionId - Primary key in the `session` table.
 * @param args.platform - Platform used for resume-command generation.
 * @returns The parsed session, or `null` when it does not exist.
 */
export function parseOpenCodeSqliteSessionViaWorker(args: {
  fullFirstUserPrompt?: boolean
  dbPath: string
  sessionId: string
  platform: NodeJS.Platform
  signal?: AbortSignal
}): Promise<AiVaultSession | null> {
  return parseForHost(args)
}

export function parseOpenCode2SqliteSessionViaWorker(args: {
  fullFirstUserPrompt?: boolean
  dbPath: string
  sessionId: string
  platform: NodeJS.Platform
  signal?: AbortSignal
}): Promise<AiVaultSession | null> {
  return parseForHost({ ...args, agent: 'opencode2' })
}

/**
 * Read one OpenCode SQLite session and its whole transcript through the shared
 * worker client.
 * @param args.dbPath - Absolute path to the opencode.db file.
 * @param args.sessionId - Primary key in the `session` table.
 * @param args.platform - Platform used for resume-command generation.
 * @returns The session and every message it holds.
 */
export function captureOpenCodeSqliteSessionViaWorker(args: {
  dbPath: string
  sessionId: string
  platform: NodeJS.Platform
  signal?: AbortSignal
}): Promise<OpenCodeSqliteCaptureValue> {
  return captureForHost(args)
}

export function captureOpenCode2SqliteSessionViaWorker(args: {
  dbPath: string
  sessionId: string
  platform: NodeJS.Platform
  signal?: AbortSignal
}): Promise<OpenCodeSqliteCaptureValue> {
  return captureForHost({ ...args, agent: 'opencode2' })
}

async function listForHost(
  args: Parameters<OpenCodeSqliteWorkerClient['list']>[0]
): Promise<SessionFileCandidate[]> {
  throwIfSignalAborted(args.signal)
  const native: string[] = []
  const groups = new Map<string, { distro: string; paths: Map<string, string> }>()
  for (const path of args.dbPaths) {
    const wsl = openCodeWslPath(path)
    if (!wsl) {
      native.push(path)
      continue
    }
    const key = wsl.distro.toLowerCase()
    const group = groups.get(key) ?? { distro: wsl.distro, paths: new Map<string, string>() }
    group.paths.set(wsl.linuxPath, path)
    groups.set(key, group)
  }
  const candidates = await Promise.all([
    native.length ? getSharedClient().list({ ...args, dbPaths: native }) : Promise.resolve([]),
    ...[...groups.values()].map(async ({ distro, paths }) => {
      const first = paths.values().next().value!
      const issues: AiVaultScanIssue[] = []
      try {
        const client = await openCodeWslClient(distro, first, args.signal)
        const result = await client.list({ ...args, dbPaths: [...paths.keys()], issues })
        return result.flatMap((candidate) => {
          const parsed = splitOpenCodeSqliteCandidate(candidate.file.path)
          const original = parsed && paths.get(parsed.dbPath)
          return parsed && original
            ? [
                {
                  ...candidate,
                  file: {
                    ...candidate.file,
                    path: buildOpenCodeSqliteCandidatePath(original, parsed.sessionId)
                  }
                }
              ]
            : []
        })
      } catch (error) {
        throwIfSignalAborted(args.signal)
        issues.push({
          agent: args.agent ?? 'opencode',
          kind: 'scope',
          path: first,
          message: error instanceof Error ? error.message : String(error)
        })
        return []
      } finally {
        args.issues.push(
          ...issues.map((issue) => ({ ...issue, path: paths.get(issue.path) ?? issue.path }))
        )
      }
    })
  ])
  throwIfSignalAborted(args.signal)
  return candidates.flat().sort((a, b) => b.file.mtimeMs - a.file.mtimeMs)
}

async function parseForHost(
  args: Parameters<OpenCodeSqliteWorkerClient['parse']>[0]
): Promise<AiVaultSession | null> {
  const wsl = openCodeWslPath(args.dbPath)
  if (!wsl) {
    return getSharedClient().parse(args)
  }
  const client = await openCodeWslClient(wsl.distro, args.dbPath, args.signal)
  const session = await client.parse({ ...args, dbPath: wsl.linuxPath, platform: 'linux' })
  return mapOpenCodeWslSession(session, args.dbPath, wsl.distro)
}

async function captureForHost(
  args: Parameters<OpenCodeSqliteWorkerClient['capture']>[0]
): Promise<OpenCodeSqliteCaptureValue> {
  const wsl = openCodeWslPath(args.dbPath)
  if (!wsl) {
    return getSharedClient().capture(args)
  }
  const client = await openCodeWslClient(wsl.distro, args.dbPath, args.signal)
  const capture = await client.capture({ ...args, dbPath: wsl.linuxPath, platform: 'linux' })
  return { ...capture, session: mapOpenCodeWslSession(capture.session, args.dbPath, wsl.distro) }
}
