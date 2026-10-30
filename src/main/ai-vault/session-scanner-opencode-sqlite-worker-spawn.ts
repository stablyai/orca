import { aiVaultScopePathsForWslDistro } from '../../shared/ai-vault-scope-cwd-match'
import { recordSessionScanIssue, scanIssueTextFromError } from './session-scan-issues'
import { existsSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import type { AiVaultScanIssue, AiVaultSession } from '../../shared/ai-vault-types'
import { throwIfSignalAborted } from '../../shared/abort-signal-reason'
import { openCodeTranscriptPageLimit } from '../../shared/opencode-transcript-page-limit'
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
import { findForeignSqliteReaderEntry } from '../foreign-sqlite-readers/foreign-sqlite-reader-entry-path'
import { runOpenCodeSqliteScanRequest } from './session-scanner-opencode-sqlite-scan-scope'
import { noteAiVaultScanDatabases, openAiVaultScanSource } from './ai-vault-scan-progress'

export function resolveOpenCodeSqliteWorkerEntryPath(
  runtimeDir = __dirname,
  pathExists: (path: string) => boolean = existsSync
): string {
  return findForeignSqliteReaderEntry(runtimeDir, pathExists)
}

function defaultWorkerFactory(): Worker {
  const workerPath = resolveOpenCodeSqliteWorkerEntryPath()
  // Fail synchronously for missing bundles rather than waiting for an impossible worker response.
  if (!existsSync(workerPath)) {
    throw new Error(`OpenCode SQLite worker entry not found: ${workerPath}`)
  }
  return new Worker(workerPath)
}

let sharedClient: OpenCodeSqliteWorkerClient | null = null

function getSharedClient(): OpenCodeSqliteWorkerClient {
  sharedClient ??= new OpenCodeSqliteWorkerClient({
    workerFactory: defaultWorkerFactory
  })
  return sharedClient
}

type SqliteParseArgs = Omit<Parameters<OpenCodeSqliteWorkerClient['parse']>[0], 'agent'>
type SqliteCaptureArgs = Omit<Parameters<OpenCodeSqliteWorkerClient['capture']>[0], 'agent'>

type SqliteListArgs = Omit<Parameters<OpenCodeSqliteWorkerClient['list']>[0], 'agent'>

export function listOpenCodeSqliteSessionsViaWorker(
  args: SqliteListArgs
): Promise<SessionFileCandidate[]> {
  return listForHost(args)
}

export function listOpenCode2SqliteSessionsViaWorker(
  args: SqliteListArgs
): Promise<SessionFileCandidate[]> {
  return listForHost({ ...args, agent: 'opencode2' })
}

export function listZcodeSqliteSessionsViaWorker(
  args: SqliteListArgs
): Promise<SessionFileCandidate[]> {
  return listForHost({ ...args, agent: 'zcode' })
}

export function parseOpenCodeSqliteSessionViaWorker(
  args: SqliteParseArgs
): Promise<AiVaultSession | null> {
  return parseForHost(args)
}

export function parseOpenCode2SqliteSessionViaWorker(
  args: SqliteParseArgs
): Promise<AiVaultSession | null> {
  return parseForHost({ ...args, agent: 'opencode2' })
}

export function parseZcodeSqliteSessionViaWorker(
  args: SqliteParseArgs
): Promise<AiVaultSession | null> {
  return parseForHost({ ...args, agent: 'zcode' })
}

export function captureOpenCodeSqliteSessionViaWorker(
  args: SqliteCaptureArgs
): Promise<OpenCodeSqliteCaptureValue> {
  return captureForHost(args)
}

export function captureOpenCode2SqliteSessionViaWorker(
  args: SqliteCaptureArgs
): Promise<OpenCodeSqliteCaptureValue> {
  return captureForHost({ ...args, agent: 'opencode2' })
}

export function captureZcodeSqliteSessionViaWorker(
  args: SqliteCaptureArgs
): Promise<OpenCodeSqliteCaptureValue> {
  return captureForHost({ ...args, agent: 'zcode' })
}

async function listForHost(
  args: Parameters<OpenCodeSqliteWorkerClient['list']>[0]
): Promise<SessionFileCandidate[]> {
  const agent = args.agent ?? 'opencode'
  const scoped = Boolean(args.scopePaths?.length)
  const issues: AiVaultScanIssue[] = []
  const closeSource =
    !scoped && args.dbPaths.length > 0 ? openAiVaultScanSource(args.signal, agent) : null
  try {
    const candidates = await listCandidatesForHost({ ...args, issues })
    // A database counts once it holds this agent's sessions: OpenCode 1 and 2 share one file.
    const dbPaths = candidates.map((c) => splitOpenCodeSqliteCandidate(c.file.path, agent)?.dbPath)
    if (!scoped) {
      noteAiVaultScanDatabases(args.signal, agent, new Set(dbPaths.filter(Boolean)).size)
    }
    return candidates
  } finally {
    for (const issue of issues) {
      if (
        !args.issues.some(
          (existing) =>
            existing.agent === issue.agent &&
            existing.path === issue.path &&
            existing.kind === issue.kind &&
            existing.message === issue.message &&
            existing.executionHostId === issue.executionHostId
        )
      ) {
        recordSessionScanIssue(args.issues, issue)
      }
    }
    closeSource?.()
  }
}

async function listCandidatesForHost(
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
    const group = groups.get(key) ?? {
      distro: wsl.distro,
      paths: new Map<string, string>()
    }
    group.paths.set(wsl.linuxPath, path)
    groups.set(key, group)
  }
  const candidates = await Promise.all([
    native.length ? getSharedClient().list({ ...args, dbPaths: native }) : Promise.resolve([]),
    ...[...groups.values()].map(async ({ distro, paths }) => {
      const scopePaths = args.scopePaths?.length
        ? aiVaultScopePathsForWslDistro(args.scopePaths, distro)
        : args.scopePaths
      if (args.scopePaths?.length && scopePaths?.length === 0) {
        return []
      }
      const first = paths.values().next().value!
      const issues: AiVaultScanIssue[] = []
      try {
        const result = await runOpenCodeSqliteScanRequest(
          args.signal,
          async (signal) => {
            const client = await openCodeWslClient(distro, first, signal)
            return client.list({
              ...args,
              signal,
              dbPaths: [...paths.keys()],
              scopePaths,
              issues
            })
          },
          args.agent
        )
        return result.flatMap((candidate) => {
          const parsed = splitOpenCodeSqliteCandidate(candidate.file.path, args.agent)
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
          ...scanIssueTextFromError(error)
        })
        return []
      } finally {
        args.issues.push(
          ...issues.map((issue) => ({
            ...issue,
            path: paths.get(issue.path) ?? issue.path
          }))
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
  const session = await runOpenCodeSqliteScanRequest(
    args.signal,
    async (signal) => {
      const client = await openCodeWslClient(wsl.distro, args.dbPath, signal)
      return client.parse({
        ...args,
        signal,
        dbPath: wsl.linuxPath,
        platform: 'linux'
      })
    },
    args.agent
  )
  return mapOpenCodeWslSession(session, args.dbPath)
}

async function captureForHost(
  args: Parameters<OpenCodeSqliteWorkerClient['capture']>[0]
): Promise<OpenCodeSqliteCaptureValue> {
  const wsl = openCodeWslPath(args.dbPath)
  if (!wsl) {
    return getSharedClient().capture(args)
  }
  const capture = await runOpenCodeSqliteScanRequest(
    args.signal,
    async (signal) => {
      const client = await openCodeWslClient(wsl.distro, args.dbPath, signal)
      return client.capture({
        ...args,
        signal,
        dbPath: wsl.linuxPath,
        platform: 'linux'
      })
    },
    args.agent
  )
  return {
    ...capture,
    session: mapOpenCodeWslSession(capture.session, args.dbPath)
  }
}

export async function readOpenCodeTranscriptPageViaWorker(
  args: {
    dbPath: string
    sessionId: string
    limit: number
    beforeMessageRowId?: number
    agent?: 'zcode'
  },
  signal?: AbortSignal
) {
  const wsl = openCodeWslPath(args.dbPath)
  const client = wsl ? await openCodeWslClient(wsl.distro, args.dbPath, signal) : getSharedClient()
  const value = await client.readNativeChat(
    {
      ...args,
      limit: openCodeTranscriptPageLimit(args.limit),
      dbPath: wsl?.linuxPath ?? args.dbPath,
      kind: 'native-page'
    },
    signal
  )
  if (value !== null && !('items' in value)) {
    throw new Error('Invalid OpenCode transcript page')
  }
  return value
}

export async function readOpenCodeTranscriptSignalViaWorker(
  args: {
    dbPath: string
    sessionId: string
    agent?: 'zcode'
  },
  signal?: AbortSignal
) {
  const wsl = openCodeWslPath(args.dbPath)
  const client = wsl ? await openCodeWslClient(wsl.distro, args.dbPath, signal) : getSharedClient()
  const value = await client.readNativeChat(
    { ...args, dbPath: wsl?.linuxPath ?? args.dbPath, kind: 'native-signal' },
    signal
  )
  if (value !== null && !('messageCount' in value)) {
    throw new Error('Invalid OpenCode transcript signal')
  }
  return value
}
