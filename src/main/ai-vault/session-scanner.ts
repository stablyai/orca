import {
  forwardRowInterest,
  rowsAreObserved,
  watchRowInterest
} from './scan-lifecycle/ai-vault-row-interest'
import { SessionRowPublisher } from './session-row-publisher'
import type { AiVaultRowObserver } from '../../shared/ai-vault-scan-rows'
import { sessionAliasKey } from '../../shared/ai-vault-session-alias'
import { ScannedSessionCollection, dedupeScannedSessions } from './parsing/session-root-dedup'
import { withTranscriptFsObservation } from '../native-chat/transcript-filesystem/transcript-fs-observation'
import { withCodexSessionIndexTitles } from './scanners/codex/session-scanner-codex-title-index'
import type {
  AiVaultListResult,
  AiVaultScanIssue,
  AiVaultSession
} from '../../shared/ai-vault/contracts/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { withSpan } from '../observability/tracer'
import { sessionSortTime } from './parsing/session-scanner-accumulator'
import {
  createAntigravityWorkspaceResolver,
  readLocalAntigravityHistory
} from './scanners/antigravity/session-scanner-antigravity-history'
import { sessionCandidatesFromDiscoveries } from './discovery/session-scanner-candidates'
import { parseSessionCandidates } from './parsing/session-scanner-candidate-parse'
import { createSessionParseStats } from './parse-cache/session-scanner-parse-cache'
import { recordSessionScanIssue } from './parsing/session-scan-issues'
import {
  aiVaultScanWorkload,
  noteAiVaultScanReading
} from './scan-lifecycle/ai-vault-scan-progress'
import { yieldScanInventory } from './scope/session-scanner-scope-inventory'
import { prepareScopeScan, scanInScopeSessions } from './scope/session-scanner-scope-walk'
import { discoverAiVaultSessionSources } from './discovery/session-scanner-source-discovery'
import { withAntigravityArtifactPaths } from './scanners/antigravity/antigravity-session-artifacts'
import {
  cursorChatMetaRefusals,
  withCursorChatMetaScan
} from './scanners/cursor/session-scanner-cursor-chat-meta'
import type { AiVaultScanOptions } from './session-scanner-types'

import { scopeOnlyScan } from './scope/session-scope-cwd'
import {
  aiVaultSessionInScope,
  createAiVaultScopeCwdMatcher
} from '../../shared/ai-vault/scanning/ai-vault-scope-cwd-match'
import { throwIfAiVaultScanCancelled } from './scan-lifecycle/ai-vault-scan-cancellation'
import { DEFAULT_AI_VAULT_SCAN_LIMIT } from '../../shared/ai-vault/scanning/ai-vault-session-depth'
import { withDevinSessionsDbScan } from './scanners/devin/session-scanner-devin-db'
import { withOpenCodeSqliteScanScope } from './scanners/opencode/sqlite/session-scanner-opencode-sqlite-scan-scope'

const SESSION_PARSE_CANDIDATE_MULTIPLIER = 2

/** Return recency-capped sessions plus recovered in-scope sessions (only those for scopeOnly), deduplicated and sorted. */
export async function scanAiVaultSessions(
  options: AiVaultScanOptions = {},
  observeRows?: AiVaultRowObserver,
  activity?: (allowanceMs: number) => void
): Promise<AiVaultListResult> {
  let publisher: SessionRowPublisher | null = null
  const finishPublisher = () => publisher?.finish()
  let winners: ScannedSessionCollection | null = null
  let byKey: Map<string, AiVaultSession> | null = null
  const inScope = scopeOnlyScan(options)
    ? createAiVaultScopeCwdMatcher(options.scopePaths ?? [])
    : null
  const publish: AiVaultRowObserver | undefined = observeRows
    ? (delta) => {
        if (!rowsAreObserved(observeRows)) {
          return
        }
        publisher ??= new SessionRowPublisher(observeRows)
        winners ??= new ScannedSessionCollection()
        byKey ??= new Map()
        for (const row of delta.upserts) {
          if (inScope && !aiVaultSessionInScope(inScope, row)) {
            continue
          }
          const key = sessionAliasKey(row) ?? row.id
          const previous = byKey.get(key)
          const change = winners.add(row)
          if (change) {
            byKey.set(key, row)
            publisher.observe({
              upserts: [row],
              removed: previous && previous.id !== row.id ? [previous.id] : []
            })
          }
        }
      }
    : undefined
  if (publish && observeRows) {
    forwardRowInterest(publish, observeRows)
  }
  const stopInterest = observeRows
    ? watchRowInterest(observeRows, () => {
        if (!rowsAreObserved(observeRows)) {
          publisher?.finish()
          publisher = null
          winners = null
          byKey = null
        }
      })
    : () => undefined
  try {
    return await withTranscriptFsObservation(
      () =>
        withCodexSessionIndexTitles(() =>
          withOpenCodeSqliteScanScope(() => scanAiVaultSessionStores(options, publish))
        ),
      activity
    )
  } finally {
    stopInterest()
    finishPublisher()
  }
}

async function scanAiVaultSessionStores(
  options: AiVaultScanOptions,
  observeRows?: AiVaultRowObserver
): Promise<AiVaultListResult> {
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

        const scopeOnly = scopeOnlyScan(options)
        const parsedSessions = await parseSessionCandidates({
          candidates: parseCandidates,
          observeRows,
          // Scope-only parses the whole window: its in-scope rows must not depend on bucket agents' rows.
          limit: scopeOnly ? Number.POSITIVE_INFINITY : limit,
          platform,
          executionHostId,
          issues,
          parseStats,
          signal: options.signal,
          antigravityWorkspaceResolver,
          settled: (candidate, parsed) => workload?.settle(candidate, 'global', parsed)
        })

        const recentSessions = dedupeScannedSessions(parsedSessions).sort(
          (left, right) => sessionSortTime(right) - sessionSortTime(left)
        )
        // Scope-only keeps the recency pass for agents without cwd buckets, but returns only its in-scope rows.
        const inScope = scopeOnly ? createAiVaultScopeCwdMatcher(options.scopePaths ?? []) : null
        const cappedSessions = inScope
          ? recentSessions.filter((session) => aiVaultSessionInScope(inScope, session))
          : recentSessions.slice(0, limit)

        const scopeSessions = await scanInScopeSessions({
          inventory,
          observeRows,
          discoveries,
          options,
          limit,
          alreadyParsedFilePaths: new Set(
            (scopeOnly ? recentSessions : cappedSessions).map((session) => session.filePath)
          ),
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
            ...refusal.text
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
          sessions: withAntigravityArtifactPaths(
            mergeSessions(cappedSessions, scopeSessions),
            discoveries
          ),
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

function clampPositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}
