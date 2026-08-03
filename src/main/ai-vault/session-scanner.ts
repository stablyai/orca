import type {
  AiVaultListResult,
  AiVaultScanIssue,
  AiVaultSession
} from '../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import { withSpan } from '../observability/tracer'
import { sessionSortTime } from './session-scanner-accumulator'
import {
  codexRolloutHardlinkIdentity,
  dedupeCodexRolloutFileAliases,
  dedupeCodexSessionsBySessionId
} from './codex-session-root-dedup'
import {
  createAntigravityWorkspaceResolver,
  readOptionalAntigravityHistoryFile
} from './session-scanner-antigravity-history'
import { antigravityHistoryPathForBrainDir } from './session-scanner-antigravity-paths'
import { codexHomeForSessionsDir } from './session-scanner-codex-paths'
import {
  ensureSessionParseCacheLoaded,
  scheduleSessionParseCachePersist
} from './session-parse-cache-persistence'
import { createSessionParseStats, type SessionParseStats } from './session-scanner-parse-cache'
import { parseSessionCandidates } from './session-scanner-candidate-parsing'
import { discoverInScopeClaudeFiles } from './session-scanner-scope-discovery'
import {
  DEFAULT_CODEX_HOME_DIR,
  discoverAiVaultSessionSources
} from './session-scanner-source-discovery'
import type {
  AiVaultScanOptions,
  SessionFileCandidate,
  SessionFileDiscovery
} from './session-scanner-types'
import { clampPositiveInteger } from './session-scanner-values'
import { OpenCodeSqliteScanContext } from './session-scanner-opencode-sqlite-scan-context'
import { recordOpenCodeSqliteScanOutcome } from './session-scanner-opencode-sqlite-scan-outcome'
import { openCodeSqliteScanCooldownRemainingMs } from './session-scanner-opencode-sqlite-scan-cooldown'
import { mergeSessions } from './session-scanner-session-merge'

const DEFAULT_LIMIT = 1000
const DEFAULT_SCAN_LIMIT_PER_AGENT = 1000
// Upper bound on extra in-scope transcripts discovered and parsed past the
// recency cap; guards against a pathological scoped history directory.
const SCOPE_PARSE_LIMIT = 2000

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
    const limit = clampPositiveInteger(options.limit, DEFAULT_LIMIT)
    const limitPerAgent = clampPositiveInteger(options.limitPerAgent, DEFAULT_SCAN_LIMIT_PER_AGENT)
    const platform = options.platform ?? process.platform
    const executionHostId = options.executionHostId ?? LOCAL_EXECUTION_HOST_ID
    const issues: AiVaultScanIssue[] = []
    const parseStats = createSessionParseStats()
    const antigravityWorkspaceResolver = createAntigravityWorkspaceResolver(
      readOptionalAntigravityHistoryFile
    )
    // Why: persisted entries must be seeded before any candidate is parsed, or
    // the cold scan gains nothing from the cache file (#9210). Seeding happens
    // before the OpenCode context exists so a large cache cannot spend its budget.
    const cacheLoadStartedAtMs = Date.now()
    await ensureSessionParseCacheLoaded()
    span.setAttribute('parseCacheLoadMs', Date.now() - cacheLoadStartedAtMs)
    const opencodeSqliteScanContext = new OpenCodeSqliteScanContext()
    // Why: a crash loop, a timeout loop, or a worker that will not spawn cannot
    // be retried into success, and this scan re-runs every cache TTL. Back off
    // process-wide instead of re-burning a core on the same doomed work.
    const cooldownRemainingMs = openCodeSqliteScanCooldownRemainingMs()
    if (cooldownRemainingMs > 0) {
      opencodeSqliteScanContext.enterCooldown(cooldownRemainingMs)
    }
    span.setAttribute('opencodeSqliteCooldownMs', cooldownRemainingMs)
    try {
      const discoveries = await discoverAiVaultSessionSources({
        options,
        limitPerAgent,
        issues,
        opencodeSqliteScanContext
      })

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
                    : undefined
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

      const parsedSessions = await parseSessionCandidates({
        candidates,
        limit,
        platform,
        executionHostId,
        issues,
        parseStats,
        antigravityWorkspaceResolver,
        opencodeSqliteScanContext
      })
      opencodeSqliteScanContext.disarmDeadline()

      const cappedSessions = dedupeCodexSessionsBySessionId(parsedSessions)
        .sort((left, right) => sessionSortTime(right) - sessionSortTime(left))
        .slice(0, limit)

      const scopeSessions = await scanInScopeSessions({
        discoveries,
        scopePaths: options.scopePaths ?? [],
        alreadyParsedFilePaths: new Set(cappedSessions.map((session) => session.filePath)),
        platform,
        executionHostId,
        issues,
        parseStats,
        opencodeSqliteScanContext
      })

      span.setAttribute('candidates', candidates.length)
      span.setAttribute('reused', parseStats.reused)
      span.setAttribute('incremental', parseStats.incremental)
      span.setAttribute('fullParses', parseStats.fullParses)
      span.setAttribute('bytesRead', parseStats.bytesRead)
      recordOpenCodeSqliteScanOutcome({
        candidates,
        context: opencodeSqliteScanContext,
        discoveries,
        issues,
        span
      })
      span.setAttribute('issues', issues.length)

      scheduleSessionParseCachePersist(parseStats)

      return {
        sessions: mergeSessions(cappedSessions, scopeSessions),
        issues: issues.map((issue) => ({ executionHostId, ...issue })),
        scannedAt: new Date().toISOString()
      }
    } finally {
      opencodeSqliteScanContext.dispose()
    }
  })
}

async function scanInScopeSessions(args: {
  discoveries: SessionFileDiscovery[]
  scopePaths: readonly string[]
  alreadyParsedFilePaths: ReadonlySet<string>
  platform: NodeJS.Platform
  executionHostId: ExecutionHostId
  issues: AiVaultScanIssue[]
  parseStats: SessionParseStats
  opencodeSqliteScanContext: OpenCodeSqliteScanContext
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
    limit: SCOPE_PARSE_LIMIT,
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
    opencodeSqliteScanContext: args.opencodeSqliteScanContext
  })
}
