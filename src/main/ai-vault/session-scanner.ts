import type {
  AiVaultListResult,
  AiVaultScanIssue,
  AiVaultSession
} from '../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { withSpan } from '../observability/tracer'
import { sessionSortTime } from './session-scanner-accumulator'
import { dedupeScannedSessions } from './session-root-dedup'
import {
  createAntigravityWorkspaceResolver,
  readLocalAntigravityHistory
} from './session-scanner-antigravity-history'
import { sessionCandidatesFromDiscoveries } from './session-scanner-candidates'
import { parseSessionCandidates } from './session-scanner-candidate-parse'
import { createSessionParseStats } from './session-scanner-parse-cache'
import { recordSessionScanIssue } from './session-scan-issues'
import { scanInScopeSessions } from './session-scanner-scope-walk'
import { discoverAiVaultSessionSources } from './session-scanner-source-discovery'
import { cursorChatMetaRefusals, withCursorChatMetaScan } from './session-scanner-cursor-chat-meta'
import type { AiVaultScanOptions } from './session-scanner-types'
import { clampPositiveInteger } from './session-scanner-values'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import { noteAiVaultScanReading } from './ai-vault-scan-progress'
import { DEFAULT_AI_VAULT_SCAN_LIMIT } from '../../shared/ai-vault-session-depth'
import { withDevinSessionsDbScan } from './session-scanner-devin-db'
import { withOpenCodeSqliteScanScope } from './session-scanner-opencode-sqlite-scan-scope'

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
  return withOpenCodeSqliteScanScope(() => scanAiVaultSessionStores(options))
}

async function scanAiVaultSessionStores(options: AiVaultScanOptions): Promise<AiVaultListResult> {
  // The span makes scan cost visible in the local trace file: STA-1278-style
  // "one core pegged" reports need to show whether transcript scanning is the
  // subsystem burning CPU, and how much of each scan the cache absorbed.
  // The Cursor chat-meta scope spans discovery AND parse: its sibling meta.json
  // is looked up in both phases, and one scan must read the chats tree once.
  return withSpan('aiVault.scan', (span) =>
    withDevinSessionsDbScan(() =>
      withCursorChatMetaScan(async () => {
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
        const antigravityWorkspaceResolver = createAntigravityWorkspaceResolver((path) =>
          readLocalAntigravityHistory(path, options.signal)
        )
        throwIfAiVaultScanCancelled(options.signal)
        const discoveries = await discoverAiVaultSessionSources({
          options,
          limitPerAgent,
          issues
        })
        throwIfAiVaultScanCancelled(options.signal)

        const candidates = await sessionCandidatesFromDiscoveries(discoveries, options)
        const parseCandidates = candidates.slice(0, limit * SESSION_PARSE_CANDIDATE_MULTIPLIER)
        noteAiVaultScanReading(options.signal, parseCandidates.length)

        const parsedSessions = await parseSessionCandidates({
          candidates: parseCandidates,
          limit,
          platform,
          executionHostId,
          issues,
          parseStats,
          signal: options.signal,
          antigravityWorkspaceResolver
        })

        const cappedSessions = dedupeScannedSessions(parsedSessions)
          .sort((left, right) => sessionSortTime(right) - sessionSortTime(left))
          .slice(0, limit)

        const scopeSessions = await scanInScopeSessions({
          discoveries,
          options,
          limit,
          alreadyParsedFilePaths: new Set(cappedSessions.map((session) => session.filePath)),
          platform,
          executionHostId,
          issues,
          parseStats,
          antigravityWorkspaceResolver
        })
        // Scope discovery can return without parsing anything, so an abort landing
        // here would otherwise persist and return a cancelled scan as complete.
        throwIfAiVaultScanCancelled(options.signal)
        for (const refusal of cursorChatMetaRefusals()) {
          // One issue per refused chats root, not one per Cursor transcript.
          recordSessionScanIssue(issues, {
            agent: 'cursor',
            path: refusal.chatsRoot,
            message: refusal.message
          })
        }

        span.setAttribute('candidates', candidates.length)
        span.setAttribute('reused', parseStats.reused)
        span.setAttribute('incremental', parseStats.incremental)
        span.setAttribute('fullParses', parseStats.fullParses)
        span.setAttribute('earlyStopped', parseStats.earlyStopped)
        span.setAttribute('bytesRead', parseStats.bytesRead)
        span.setAttribute('issues', issues.length)

        return {
          sessions: mergeSessions(cappedSessions, scopeSessions),
          issues: issues.map((issue) => ({ executionHostId, ...issue })),
          scannedAt: new Date().toISOString()
        }
      })
    )
  )
}

// In-scope sessions are guaranteed regardless of the recency cap, so the global
// (already capped) result and the scope result are unioned by session id, then
// alias-deduped (a rollout's copy in another Codex home), then re-sorted DESC.
function mergeSessions(
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
  return dedupeScannedSessions([...byId.values()]).sort(
    (left, right) => sessionSortTime(right) - sessionSortTime(left)
  )
}
