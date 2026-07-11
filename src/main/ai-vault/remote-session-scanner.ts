import { extname } from 'node:path'
import type {
  AiVaultAgent,
  AiVaultListResult,
  AiVaultScanIssue,
  AiVaultSession
} from '../../shared/ai-vault-types'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { FileStat, IFilesystemProvider } from '../providers/types'
import type { RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { joinRemotePath } from '../ssh/ssh-remote-platform'
import { sessionSortTime } from './session-scanner-accumulator'
import { partitionSubagentTranscriptPaths } from './session-scanner-subagent-transcripts'
import type { FileWithMtime } from './session-scanner-types'
import { errorMessage } from './session-scanner-values'
import { remoteSessionSources } from './remote-session-scanner-sources'
import type {
  RemoteScannerContext,
  RemoteSessionCandidate,
  RemoteSessionSource
} from './remote-session-scanner-types'

const DEFAULT_REMOTE_SCAN_LIMIT = 1000
const REMOTE_SCAN_CONCURRENCY = 8
const REMOTE_SCOPE_PARSE_LIMIT = 2000

export async function scanRemoteAiVaultSessions(args: {
  provider: IFilesystemProvider
  executionHostId: ExecutionHostId
  remoteHome: string
  hostPlatform: RemoteHostPlatform
  limit?: number
  scopePaths?: readonly string[]
}): Promise<AiVaultListResult> {
  const limit = args.limit && args.limit > 0 ? Math.floor(args.limit) : DEFAULT_REMOTE_SCAN_LIMIT
  const issues: AiVaultScanIssue[] = []
  const context: RemoteScannerContext = {
    provider: args.provider,
    executionHostId: args.executionHostId,
    hostPlatform: args.hostPlatform,
    titleCaches: new Map()
  }
  const candidates = (
    await mapRemoteScanConcurrently(
      remoteSessionSources(args.remoteHome, args.hostPlatform),
      (source) => discoverRemoteSourceCandidates({ source, context, issues })
    )
  )
    .flat()
    .sort((left, right) => right.file.mtimeMs - left.file.mtimeMs)

  const parsed = await parseRemoteSessionCandidates({ candidates, context, issues, limit })
  const cappedSessions = parsed.sessions
    .sort((left, right) => sessionSortTime(right) - sessionSortTime(left))
    .slice(0, limit)
  const scopePaths = normalizeRemoteScopePaths(args.scopePaths ?? [])
  const parsedScopeSessions = parsed.sessions.filter((session) =>
    isRemoteSessionInScope(session, scopePaths)
  )
  const extraScopeSessions = await scanRemoteInScopeSessions({
    candidates,
    context,
    issues,
    scopePaths,
    alreadyParsedFilePaths: parsed.parsedFilePaths
  })

  return {
    sessions: mergeRemoteSessions(cappedSessions, [...parsedScopeSessions, ...extraScopeSessions]),
    issues,
    scannedAt: new Date().toISOString()
  }
}

async function discoverRemoteSourceCandidates(args: {
  source: RemoteSessionSource
  context: RemoteScannerContext
  issues: AiVaultScanIssue[]
}): Promise<RemoteSessionCandidate[]> {
  const walked = await walkRemoteSessionFiles(
    args.source,
    args.context.provider,
    args.context.hostPlatform
  )
  const partition = args.source.collectSubagentSiblingCounts
    ? partitionSubagentTranscriptPaths(walked)
    : null
  const paths = partition ? partition.sessionFilePaths : walked
  const files = await mapRemoteScanConcurrently(paths, (path) =>
    statRemoteFile(
      args.context.provider,
      path,
      args.source.agent,
      args.context.executionHostId,
      args.issues
    )
  )
  return files
    .filter((file): file is FileWithMtime => Boolean(file))
    .map((file) => ({
      source: args.source,
      file,
      subagentTranscriptCount: partition?.subagentTranscriptCounts.get(file.path) ?? 0
    }))
}

async function walkRemoteSessionFiles(
  source: RemoteSessionSource,
  provider: IFilesystemProvider,
  hostPlatform: RemoteHostPlatform,
  dirPath = source.rootDir
): Promise<string[]> {
  let entries
  try {
    entries = await provider.readDir(dirPath)
  } catch {
    return []
  }

  const extensions = new Set(source.extensions)
  const files: string[] = []
  for (const entry of entries) {
    const fullPath = joinRemotePath(hostPlatform, dirPath, entry.name)
    if (entry.isDirectory && !entry.isSymlink) {
      files.push(...(await walkRemoteSessionFiles(source, provider, hostPlatform, fullPath)))
      continue
    }
    if (
      !entry.isSymlink &&
      extensions.has(extname(entry.name).toLowerCase()) &&
      (source.filePredicate?.(fullPath) ?? true)
    ) {
      files.push(fullPath)
    }
  }
  return files
}

async function parseRemoteSessionCandidates(args: {
  candidates: readonly RemoteSessionCandidate[]
  context: RemoteScannerContext
  issues: AiVaultScanIssue[]
  limit: number
}): Promise<{ sessions: AiVaultSession[]; parsedFilePaths: Set<string> }> {
  const sessions: AiVaultSession[] = []
  const parsedFilePaths = new Set<string>()
  let index = 0

  while (index < args.candidates.length) {
    if (canStopParsingRemoteSessions(sessions, args.limit, args.candidates[index]?.file.mtimeMs)) {
      break
    }

    const batch = args.candidates.slice(index, index + REMOTE_SCAN_CONCURRENCY)
    for (const candidate of batch) {
      parsedFilePaths.add(candidate.file.path)
    }
    const results = await Promise.all(
      batch.map((candidate) => parseRemoteSessionCandidate(candidate, args.context, args.issues))
    )
    sessions.push(...results.filter(isAiVaultSession))
    index += batch.length
  }

  return { sessions, parsedFilePaths }
}

async function scanRemoteInScopeSessions(args: {
  candidates: readonly RemoteSessionCandidate[]
  context: RemoteScannerContext
  issues: AiVaultScanIssue[]
  scopePaths: readonly string[]
  alreadyParsedFilePaths: ReadonlySet<string>
}): Promise<AiVaultSession[]> {
  if (args.scopePaths.length === 0) {
    return []
  }

  const candidates = args.candidates
    .filter((candidate) => !args.alreadyParsedFilePaths.has(candidate.file.path))
    .slice(0, REMOTE_SCOPE_PARSE_LIMIT)
  const sessions: AiVaultSession[] = []

  for (let index = 0; index < candidates.length; index += REMOTE_SCAN_CONCURRENCY) {
    const batch = candidates.slice(index, index + REMOTE_SCAN_CONCURRENCY)
    const results = await Promise.all(
      batch.map((candidate) => parseRemoteSessionCandidate(candidate, args.context, args.issues))
    )
    sessions.push(
      ...results.filter(
        (session): session is AiVaultSession =>
          isAiVaultSession(session) && isRemoteSessionInScope(session, args.scopePaths)
      )
    )
  }

  return sessions
}

async function parseRemoteSessionCandidate(
  candidate: RemoteSessionCandidate,
  context: RemoteScannerContext,
  issues: AiVaultScanIssue[]
): Promise<AiVaultSession | null> {
  try {
    const read = await context.provider.readFile(candidate.file.path)
    if (read.isBinary) {
      return null
    }
    const session = await candidate.source.parse(candidate.file, read.content, context)
    // Mirror the local rule: every session carries its sibling subagent
    // transcript count (row badge; recoverable signal at zero turns). The
    // walk listing supplies it — the parser can't readdir a remote disk.
    const subagentTranscriptCount = candidate.subagentTranscriptCount ?? 0
    if (session && subagentTranscriptCount > 0) {
      return { ...session, subagentTranscriptCount }
    }
    return session
  } catch (err) {
    issues.push({
      executionHostId: context.executionHostId,
      agent: candidate.source.agent,
      path: candidate.file.path,
      message: errorMessage(err)
    })
    return null
  }
}

function mergeRemoteSessions(
  cappedSessions: AiVaultSession[],
  scopeSessions: AiVaultSession[]
): AiVaultSession[] {
  if (scopeSessions.length === 0) {
    return cappedSessions
  }
  const byId = new Map<string, AiVaultSession>()
  for (const session of cappedSessions) {
    byId.set(session.id, session)
  }
  for (const session of scopeSessions) {
    byId.set(session.id, session)
  }
  return [...byId.values()].sort((left, right) => sessionSortTime(right) - sessionSortTime(left))
}

function isRemoteSessionInScope(session: AiVaultSession, scopePaths: readonly string[]): boolean {
  const cwd = session.cwd
  return Boolean(cwd && scopePaths.some((scopePath) => isPathInsideOrEqual(scopePath, cwd)))
}

function normalizeRemoteScopePaths(scopePaths: readonly string[]): string[] {
  return scopePaths.map((scopePath) => scopePath.trim()).filter(Boolean)
}

async function statRemoteFile(
  provider: IFilesystemProvider,
  path: string,
  agent: AiVaultAgent,
  executionHostId: ExecutionHostId,
  issues: AiVaultScanIssue[]
): Promise<FileWithMtime | null> {
  try {
    const stat = await provider.stat(path)
    const mtimeMs = remoteStatMtimeMs(stat)
    return { path, mtimeMs, modifiedAt: new Date(mtimeMs).toISOString() }
  } catch (err) {
    issues.push({ executionHostId, agent, path, message: errorMessage(err) })
    return null
  }
}

function remoteStatMtimeMs(stat: FileStat): number {
  if (typeof stat.mtimeMs === 'number' && Number.isFinite(stat.mtimeMs)) {
    return stat.mtimeMs
  }
  return stat.mtime > 10_000_000_000 ? stat.mtime : stat.mtime * 1000
}

function canStopParsingRemoteSessions(
  sessions: AiVaultSession[],
  limit: number,
  nextCandidateMtimeMs: number | undefined
): boolean {
  if (sessions.length < limit || typeof nextCandidateMtimeMs !== 'number') {
    return false
  }
  const visibleCutoff = sessions
    .map(sessionSortTime)
    .sort((left, right) => right - left)
    .at(limit - 1)

  // Transcript mtimes bound the remaining candidate order; once the visible
  // cutoff is newer, older files cannot enter the unscoped top-N result.
  return typeof visibleCutoff === 'number' && nextCandidateMtimeMs < visibleCutoff
}

function isAiVaultSession(session: AiVaultSession | null): session is AiVaultSession {
  return Boolean(session)
}

async function mapRemoteScanConcurrently<T, U>(
  items: readonly T[],
  mapper: (item: T) => Promise<U>
): Promise<U[]> {
  const results: U[] = []
  for (let index = 0; index < items.length; index += REMOTE_SCAN_CONCURRENCY) {
    const batch = items.slice(index, index + REMOTE_SCAN_CONCURRENCY)
    results.push(...(await Promise.all(batch.map(mapper))))
  }
  return results
}
