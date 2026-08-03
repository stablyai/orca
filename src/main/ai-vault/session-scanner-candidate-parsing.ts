import type { AiVaultScanIssue, AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { sessionSortTime } from './session-scanner-accumulator'
import { dedupeCodexSessionsBySessionId } from './codex-session-root-dedup'
import type { AntigravityWorkspaceResolver } from './session-scanner-antigravity-history'
import { withSessionExecutionHost } from './session-scanner-execution-host'
import { OpenCodeSqliteCandidatePhase } from './session-scanner-opencode-sqlite-candidate-phase'
import {
  isOpenCodeSqliteScanTerminatedError,
  type OpenCodeSqliteScanContext
} from './session-scanner-opencode-sqlite-scan-context'
import { parseAgentSessionFileCached, type SessionParseStats } from './session-scanner-parse-cache'
import type { SessionFileCandidate, SessionParseResult } from './session-scanner-types'
import { errorMessage } from './session-scanner-values'

// Bounded fan-out: transcripts are parsed in batches so a large corpus cannot
// open every file at once, and so the recency cap can stop the walk early.
const SESSION_PARSE_CONCURRENCY = 8

export async function parseSessionCandidates(args: {
  candidates: SessionFileCandidate[]
  limit: number
  platform: NodeJS.Platform
  executionHostId: ExecutionHostId
  issues: AiVaultScanIssue[]
  parseStats: SessionParseStats
  antigravityWorkspaceResolver?: AntigravityWorkspaceResolver
  opencodeSqliteScanContext: OpenCodeSqliteScanContext
}): Promise<AiVaultSession[]> {
  const sessions: AiVaultSession[] = []
  let index = 0
  const opencodePhase = new OpenCodeSqliteCandidatePhase({
    candidates: args.candidates,
    platform: args.platform,
    context: args.opencodeSqliteScanContext
  })

  while (index < args.candidates.length) {
    if (canStopParsingSessions(sessions, args.limit, args.candidates[index]?.file.mtimeMs)) {
      break
    }

    const remaining = args.candidates.length - index
    const needed = Math.max(args.limit - sessions.length, 1)
    const batchSize = Math.min(SESSION_PARSE_CONCURRENCY, needed, remaining)
    const batch = args.candidates.slice(index, index + batchSize)
    const parseableBatch = opencodePhase.prepareBatch(batch)
    const parsePromises = parseableBatch.map((candidate) =>
      parseSessionCandidate(
        candidate,
        args.platform,
        args.executionHostId,
        args.parseStats,
        args.antigravityWorkspaceResolver,
        args.opencodeSqliteScanContext
      )
    )
    opencodePhase.trackBatch(parseableBatch, parsePromises)
    const results = await Promise.all(parsePromises)

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

  opencodePhase.finish()
  return sessions
}

async function parseSessionCandidate(
  candidate: SessionFileCandidate,
  platform: NodeJS.Platform,
  executionHostId: ExecutionHostId,
  parseStats: SessionParseStats,
  antigravityWorkspaceResolver: AntigravityWorkspaceResolver | undefined,
  opencodeSqliteScanContext: OpenCodeSqliteScanContext
): Promise<SessionParseResult> {
  try {
    let session = await parseAgentSessionFileCached(
      candidate,
      platform,
      parseStats,
      opencodeSqliteScanContext
    )
    if (session && candidate.antigravityHistoryPath && antigravityWorkspaceResolver) {
      session = await antigravityWorkspaceResolver.enrich(session, candidate.antigravityHistoryPath)
    }
    return {
      session: session ? withSessionExecutionHost(session, executionHostId) : null,
      issue: null
    }
  } catch (err) {
    if (isOpenCodeSqliteScanTerminatedError(err)) {
      return { session: null, issue: null }
    }
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
