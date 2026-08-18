import type { AiVaultScanIssue, AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { sessionSortTime } from './session-scanner-accumulator'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import { dedupeCodexSessionsBySessionId } from './codex-session-root-dedup'
import { recordSessionScanIssue } from './session-scan-issues'
import type { AntigravityWorkspaceResolver } from './session-scanner-antigravity-history'
import { withSessionExecutionHost } from './session-scanner-host-stamp'
import { parseAgentSessionFileCached, type SessionParseStats } from './session-scanner-parse-cache'
import type { SessionFileCandidate, SessionParseResult } from './session-scanner-types'
import { errorMessage } from './session-scanner-values'

const SESSION_PARSE_CONCURRENCY = 8

export async function parseSessionCandidates(args: {
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
        recordSessionScanIssue(args.issues, result.issue)
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

export function canStopParsingSessions(
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
