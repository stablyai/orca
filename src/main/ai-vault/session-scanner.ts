import { readFile } from 'node:fs/promises'
import type {
  AiVaultListResult,
  AiVaultScanIssue,
  AiVaultSession
} from '../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import { buildAiVaultSessionId } from '../../shared/ai-vault-session-id'
import { withSpan } from '../observability/tracer'
import { sessionSortTime } from './session-scanner-accumulator'
import { mergeAiVaultSessions } from './session-list-results'
import {
  codexRolloutHardlinkIdentity,
  dedupeCodexRolloutFileAliases,
  dedupeCodexSessionsBySessionId
} from './codex-session-root-dedup'
import {
  createAntigravityWorkspaceResolver,
  type AntigravityWorkspaceResolver
} from './session-scanner-antigravity-history'
import { antigravityHistoryPathForBrainDir } from './session-scanner-antigravity-paths'
import { codexHomeForSessionsDir } from './session-scanner-codex-paths'
import {
  ensureSessionParseCacheLoaded,
  scheduleSessionParseCachePersist
} from './session-parse-cache-persistence'
import {
  createSessionParseStats,
  parseAgentSessionFileCached,
  type SessionParseStats
} from './session-scanner-parse-cache'
import { discoverInScopeClaudeFiles } from './session-scanner-scope-discovery'
import {
  DEFAULT_CODEX_HOME_DIR,
  discoverAiVaultSessionSources
} from './session-scanner-source-discovery'
import type {
  AiVaultScanOptions,
  SessionFileCandidate,
  SessionFileDiscovery,
  SessionParseResult
} from './session-scanner-types'
import { clampPositiveInteger, errorMessage } from './session-scanner-values'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import { DEFAULT_AI_VAULT_SCAN_LIMIT } from '../../shared/ai-vault-session-depth'
import { processLocalCursorCandidates } from './session-scanner-cursor-local-pipeline'

const SESSION_PARSE_CONCURRENCY = 8
const SESSION_PARSE_CANDIDATE_MULTIPLIER = 2

/**
 * Scan all supported AI agent session stores and return a unified, sorted,
 * deduplicated list of sessions for the AI Vault panel. Discovers sessions
 * from file-based stores (Claude, Codex, Gemini, etc.) and SQLite-based
 * stores (OpenCode 1.17.x). Results are sorted by session sort time DESC
 * and truncated to `limit`.
 * @param options - Optional scan configuration (limits, custom dirs, platform).
 * @returns The list of sessions, scan issues, and a timestamp.
 */
export async function scanAiVaultSessions(
  options: AiVaultScanOptions = {}
): Promise<AiVaultListResult> {
  // The span makes scan cost visible in the local trace file: STA-1278-style
  // "one core pegged" reports need to show whether transcript scanning is the
  // subsystem burning CPU, and how much of each scan the cache absorbed.
  return withSpan('aiVault.scan', async (span) => {
    const limit = options.unlimited
      ? Number.POSITIVE_INFINITY
      : clampPositiveInteger(options.limit, DEFAULT_AI_VAULT_SCAN_LIMIT)
    const limitPerAgent = options.unlimited
      ? Number.POSITIVE_INFINITY
      : clampPositiveInteger(options.limitPerAgent, limit * SESSION_PARSE_CANDIDATE_MULTIPLIER)
    const platform = options.platform ?? process.platform
    const executionHostId = options.executionHostId ?? LOCAL_EXECUTION_HOST_ID
    const issues: AiVaultScanIssue[] = []
    const parseStats = createSessionParseStats()
    const antigravityWorkspaceResolver = createAntigravityWorkspaceResolver(readOptionalTextFile)
    // Why: persisted entries must be seeded before any candidate is parsed, or
    // the cold scan gains nothing from the cache file (#9210).
    throwIfAiVaultScanCancelled(options.signal)
    await ensureSessionParseCacheLoaded()
    const discoveries = await discoverAiVaultSessionSources({ options, limitPerAgent, issues })
    throwIfAiVaultScanCancelled(options.signal)

    const candidates = dedupeCodexRolloutFileAliases(
      discoveries
        .flatMap((discovery) =>
          discovery.files.map(
            (file): SessionFileCandidate => ({
              agent: discovery.agent,
              file,
              codexHome:
                discovery.agent === 'codex'
                  ? codexHomeForSessionsDir(
                      discovery.rootDir,
                      options.defaultCodexHomeDir ?? DEFAULT_CODEX_HOME_DIR
                    )
                  : null,
              antigravityHistoryPath:
                discovery.agent === 'antigravity'
                  ? antigravityHistoryPathForBrainDir(discovery.rootDir)
                  : undefined,
              cursorLayout: discovery.cursorLayout,
              cursorStorageContextKey: discovery.cursorStorageContextKey,
              cursorCwdEvidence: discovery.cursorCwdEvidenceByPath?.get(file.path),
              cursorExpectedRootRealPath: discovery.cursorExpectedRootRealPath
            })
          )
        )
        .sort((left, right) => right.file.mtimeMs - left.file.mtimeMs),
      {
        isCodex: (candidate) => candidate.agent === 'codex',
        getFilePath: (candidate) => candidate.file.path,
        getCodexHome: (candidate) => candidate.codexHome,
        getHardlinkIdentity: (candidate) => codexRolloutHardlinkIdentity(candidate.file)
      }
    )

    const cursorCandidates = candidates.filter((candidate) => candidate.agent === 'cursor')
    const nonCursorCandidates = candidates.filter((candidate) => candidate.agent !== 'cursor')
    const cursorResult = await processLocalCursorCandidates({
      candidates: cursorCandidates,
      limit,
      scopeLimit: limit,
      platform,
      executionHostId,
      issues,
      parseStats,
      span
    })
    throwIfAiVaultScanCancelled(options.signal)
    const parsedSessions = await parseSessionCandidates({
      candidates: nonCursorCandidates.slice(0, limit * SESSION_PARSE_CANDIDATE_MULTIPLIER),
      limit,
      platform,
      executionHostId,
      issues,
      parseStats,
      signal: options.signal,
      antigravityWorkspaceResolver
    })

    const cappedSessions = dedupeCodexSessionsBySessionId([
      ...parsedSessions,
      ...cursorResult.sessions
    ])
      .sort((left, right) => sessionSortTime(right) - sessionSortTime(left))
      .slice(0, limit)

    const scopeSessions = await scanInScopeSessions({
      discoveries,
      scopePaths: options.scopePaths ?? [],
      limit,
      alreadyParsedFilePaths: new Set(cappedSessions.map((session) => session.filePath)),
      platform,
      executionHostId,
      issues,
      parseStats,
      signal: options.signal
    })
    // Scope discovery can return without parsing anything, so an abort landing
    // here would otherwise persist and return a cancelled scan as complete.
    throwIfAiVaultScanCancelled(options.signal)
    const cursorScopeSessions = cursorResult.sessions.filter((session) =>
      cursorResult.scopedSessionIds.has(session.id)
    )

    span.setAttribute('candidates', candidates.length)
    span.setAttribute('reused', parseStats.reused)
    span.setAttribute('incremental', parseStats.incremental)
    span.setAttribute('fullParses', parseStats.fullParses)
    span.setAttribute('bytesRead', parseStats.bytesRead)
    span.setAttribute('issues', issues.length)
    scheduleSessionParseCachePersist(parseStats)

    return {
      sessions: mergeAiVaultSessions(cappedSessions, [...scopeSessions, ...cursorScopeSessions]),
      issues: issues.map((issue) => ({ executionHostId, ...issue })),
      scannedAt: new Date().toISOString()
    }
  })
}

async function scanInScopeSessions(args: {
  discoveries: SessionFileDiscovery[]
  scopePaths: readonly string[]
  limit: number
  alreadyParsedFilePaths: ReadonlySet<string>
  platform: NodeJS.Platform
  executionHostId: ExecutionHostId
  issues: AiVaultScanIssue[]
  parseStats: SessionParseStats
  signal?: AbortSignal
}): Promise<AiVaultSession[]> {
  if (args.scopePaths.length === 0) {
    return []
  }
  const claudeRootDirs = args.discoveries
    .filter((discovery) => discovery.agent === 'claude')
    .map((discovery) => discovery.rootDir)
  const files = await discoverInScopeClaudeFiles({
    rootDirs: claudeRootDirs,
    scopePaths: args.scopePaths,
    limit: args.limit,
    excludedFilePaths: args.alreadyParsedFilePaths,
    issues: args.issues
  })
  const candidates = files.map(
    (file): SessionFileCandidate => ({ agent: 'claude', file, codexHome: null })
  )
  if (candidates.length === 0) {
    return []
  }
  // Parse every in-scope candidate (limit === candidate count never early-stops).
  return parseSessionCandidates({
    candidates,
    limit: candidates.length,
    platform: args.platform,
    executionHostId: args.executionHostId,
    issues: args.issues,
    parseStats: args.parseStats,
    signal: args.signal
  })
}

async function parseSessionCandidates(args: {
  candidates: SessionFileCandidate[]
  limit: number
  platform: NodeJS.Platform
  executionHostId: ExecutionHostId
  issues: AiVaultScanIssue[]
  parseStats: SessionParseStats
  signal?: AbortSignal
  antigravityWorkspaceResolver?: AntigravityWorkspaceResolver
}): Promise<AiVaultSession[]> {
  const sessions: AiVaultSession[] = []
  let index = 0

  while (index < args.candidates.length) {
    throwIfAiVaultScanCancelled(args.signal)
    if (canStopParsingSessions(sessions, args.limit, args.candidates[index]?.file.mtimeMs)) {
      break
    }

    const remaining = args.candidates.length - index
    const needed = Math.max(args.limit - sessions.length, 1)
    const batchSize = Math.min(SESSION_PARSE_CONCURRENCY, needed, remaining)
    const batch = args.candidates.slice(index, index + batchSize)
    const results = await Promise.all(
      batch.map((candidate) =>
        parseSessionCandidate(
          candidate,
          args.platform,
          args.executionHostId,
          args.parseStats,
          args.antigravityWorkspaceResolver
        )
      )
    )

    for (const result of results) {
      if (result.issue) {
        args.issues.push(result.issue)
      }
      if (result.session) {
        sessions.push(result.session)
      }
    }

    // Why: cross-volume backfill copies have no shared inode, so collapse
    // parsed aliases before they can crowd the unique-session parse budget.
    const uniqueSessions = dedupeCodexSessionsBySessionId(sessions)
    sessions.splice(0, sessions.length, ...uniqueSessions)

    index += batchSize
  }

  // An abort can land while the final batch settles; observe it here so a
  // partial parse is never cached or returned as a complete scan.
  throwIfAiVaultScanCancelled(args.signal)
  return sessions
}

async function parseSessionCandidate(
  candidate: SessionFileCandidate,
  platform: NodeJS.Platform,
  executionHostId: ExecutionHostId,
  parseStats: SessionParseStats,
  antigravityWorkspaceResolver?: AntigravityWorkspaceResolver
): Promise<SessionParseResult> {
  try {
    let session = await parseAgentSessionFileCached(candidate, platform, parseStats)
    if (session && candidate.antigravityHistoryPath && antigravityWorkspaceResolver) {
      session = await antigravityWorkspaceResolver.enrich(session, candidate.antigravityHistoryPath)
    }
    return {
      session: session ? withSessionExecutionHost(session, executionHostId) : null,
      issue: null
    }
  } catch (err) {
    return {
      session: null,
      issue: {
        executionHostId,
        agent: candidate.agent,
        path: candidate.file.path,
        message: errorMessage(err)
      }
    }
  }
}

async function readOptionalTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}

function withSessionExecutionHost(
  session: AiVaultSession,
  executionHostId: ExecutionHostId
): AiVaultSession {
  if (session.executionHostId === executionHostId) {
    return session
  }
  return {
    ...session,
    executionHostId,
    id: buildAiVaultSessionId({
      executionHostId,
      agent: session.agent,
      sessionId: session.sessionId,
      filePath: session.filePath,
      previousId: session.id
    })
  }
}

function canStopParsingSessions(
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

  // Transcript mtime is already our discovery bound and fallback sort key; older
  // files cannot displace the current visible set once the cutoff is newer.
  return typeof visibleCutoff === 'number' && nextCandidateMtimeMs < visibleCutoff
}
