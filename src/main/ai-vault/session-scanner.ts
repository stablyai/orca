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
import { aiVaultScanWorkload, noteAiVaultScanReading } from './ai-vault-scan-progress'
import { yieldScanInventory } from './session-scanner-scope-inventory'
import { prepareScopeScan, scanInScopeSessions } from './session-scanner-scope-walk'
import { discoverAiVaultSessionSources } from './session-scanner-source-discovery'
import { cursorChatMetaRefusals, withCursorChatMetaScan } from './session-scanner-cursor-chat-meta'
import type { AiVaultScanOptions } from './session-scanner-types'
import { clampPositiveInteger } from './session-scanner-values'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import { DEFAULT_AI_VAULT_SCAN_LIMIT } from '../../shared/ai-vault-session-depth'
import { withDevinSessionsDbScan } from './session-scanner-devin-db'
import { withOpenCodeSqliteScanScope } from './session-scanner-opencode-sqlite-scan-scope'

const SESSION_PARSE_CANDIDATE_MULTIPLIER = 2

/** Return recency-capped sessions plus recovered in-scope sessions, deduplicated and sorted. */
export async function scanAiVaultSessions(
  options: AiVaultScanOptions = {}
): Promise<AiVaultListResult> {
  return withOpenCodeSqliteScanScope(() => scanAiVaultSessionStores(options))
}

async function scanAiVaultSessionStores(options: AiVaultScanOptions): Promise<AiVaultListResult> {
  // Keep Cursor metadata scoped across discovery and parsing to read the chats tree only once.
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

        const workload = aiVaultScanWorkload(options.signal)
        if (workload) {
          for (const [index, candidate] of parseCandidates.entries()) {
            await yieldScanInventory(index, options.signal)
            workload.register(candidate, 'global')
          }
        }
        const inventory = await prepareScopeScan({ discoveries, options, limit })
        throwIfAiVaultScanCancelled(options.signal)
        noteAiVaultScanReading(options.signal)

        const parsedSessions = await parseSessionCandidates({
          candidates: parseCandidates,
          limit,
          platform,
          executionHostId,
          issues,
          parseStats,
          signal: options.signal,
          antigravityWorkspaceResolver,
          settled: (candidate, parsed) => workload?.settle(candidate, 'global', parsed)
        })

        const cappedSessions = dedupeScannedSessions(parsedSessions)
          .sort((left, right) => sessionSortTime(right) - sessionSortTime(left))
          .slice(0, limit)

        const scopeSessions = await scanInScopeSessions({
          inventory,
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
        // Scope discovery may parse nothing; check cancellation before returning a completed scan.
        throwIfAiVaultScanCancelled(options.signal)
        for (const refusal of cursorChatMetaRefusals()) {
          // Report each refused chats root once across its Cursor transcripts.
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

// Merge scope recovery without applying the global recency cap again.
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
