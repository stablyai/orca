import { yieldToEventLoop } from '../../shared/event-loop-yield'
import { isConversationNameRequestSession } from './conversation-name-request-sessions'
import { candidateFileTime } from './antigravity-transcript-candidates'
import type { AiVaultScanIssue, AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { ScannedSessionCollection } from './session-root-dedup'
import type { AntigravityWorkspaceResolver } from './session-scanner-antigravity-history'
import {
  parseAgentSessionFileCached,
  parseListedSessionFile,
  type SessionParseStats
} from './session-scanner-parse-cache'
import { recordSessionScanIssue, scanIssueTextFromError } from './session-scan-issues'
import {
  getSessionParseCacheEntry,
  noteSessionParseCacheListed,
  sessionParseCacheKey
} from './session-parse-cache-store'
import { describeSkippedTranscriptRecords } from './session-transcript-record-budget'
import { canStopParsingSessions } from './session-scan-cutoff'
import type { SessionFileCandidate, SessionParseResult } from './session-scanner-types'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import { noteAiVaultScanWorkChanged } from './ai-vault-scan-progress'

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
  selectCandidate?: (candidate: SessionFileCandidate) => Promise<boolean>
  admitSession?: (session: AiVaultSession) => boolean
  listed?: boolean
  settled?: (candidate: SessionFileCandidate, parsed: boolean) => void
}): Promise<AiVaultSession[]> {
  const sessions = new ScannedSessionCollection()
  let nextYieldIndex = 256
  let nextCutoffIndex = 0
  let index = 0
  while (index < args.candidates.length) {
    if (index >= nextYieldIndex) {
      await yieldToEventLoop()
      nextYieldIndex = index + 256
    }
    throwIfAiVaultScanCancelled(args.signal)
    if (!args.selectCandidate || (Number.isFinite(args.limit) && index >= nextCutoffIndex)) {
      if (
        canStopParsingSessions(
          sessions,
          args.limit,
          candidateFileTime(args.candidates[index]?.file)
        )
      ) {
        break
      }
      // Exhaustive walks retain every canonical row: amortize repeated ranking over the cursor.
      if (args.selectCandidate && sessions.size >= args.limit) {
        nextCutoffIndex = Math.max(index * 2, index + SESSION_PARSE_CONCURRENCY)
      }
    }

    const remaining = args.candidates.length - index
    const needed = Math.max(args.limit - sessions.size, 1)
    const batchSize = Math.min(
      SESSION_PARSE_CONCURRENCY,
      args.selectCandidate ? remaining : needed,
      remaining
    )
    const batch = args.candidates.slice(index, index + batchSize)
    index += batchSize
    const verdicts = args.selectCandidate
      ? await Promise.all(batch.map(args.selectCandidate))
      : batch.map(() => true)
    throwIfAiVaultScanCancelled(args.signal)
    const selected = batch.filter((_, batchIndex) => verdicts[batchIndex])
    const results = await Promise.all(
      selected.map((candidate) =>
        parseSessionCandidate(candidate, {
          platform: args.platform,
          executionHostId: args.executionHostId,
          parseStats: args.parseStats,
          antigravityWorkspaceResolver: args.antigravityWorkspaceResolver,
          listed: args.listed ?? true,
          signal: args.signal
        })
      )
    )
    // Cancellation during a batch must propagate before partial results become issues or listed sessions.
    throwIfAiVaultScanCancelled(args.signal)
    batch.forEach((candidate, index) => args.settled?.(candidate, verdicts[index]))
    noteAiVaultScanWorkChanged(args.signal)

    results.forEach((result, resultIndex) => {
      if (result.issue) {
        recordSessionScanIssue(args.issues, result.issue)
      }
      if (
        result.session &&
        !isConversationNameRequestSession(result.session) &&
        (!args.admitSession || args.admitSession(result.session))
      ) {
        if (args.listed === false) {
          const { agent, file } = selected[resultIndex]
          noteSessionParseCacheListed(sessionParseCacheKey(agent, file.path))
        }
        sessions.add(result.session)
      }
    })
  }

  for (; index < args.candidates.length; index++) {
    if (index % 256 === 0) {
      await yieldToEventLoop()
    }
    throwIfAiVaultScanCancelled(args.signal)
    args.settled?.(args.candidates[index], false)
  }
  noteAiVaultScanWorkChanged(args.signal)
  return [...sessions.values()]
}

export async function parseSessionCandidate(
  candidate: SessionFileCandidate,
  context: {
    platform: NodeJS.Platform
    executionHostId: ExecutionHostId
    parseStats: SessionParseStats
    antigravityWorkspaceResolver?: AntigravityWorkspaceResolver
    // Unlisted parses remain count-bounded in the hot cache.
    listed: boolean
    signal?: AbortSignal
  }
): Promise<SessionParseResult> {
  const { platform, executionHostId, parseStats, antigravityWorkspaceResolver, signal } = context
  try {
    let session = context.listed
      ? await parseListedSessionFile(candidate, platform, parseStats, signal)
      : await parseAgentSessionFileCached(candidate, platform, parseStats, undefined, signal)
    if (session && candidate.antigravityHistoryPath && antigravityWorkspaceResolver) {
      session = await antigravityWorkspaceResolver.enrich(session, candidate.antigravityHistoryPath)
    }
    return {
      session: session ? withSessionExecutionHost(session, executionHostId) : null,
      issue: skippedRecordIssue(candidate, executionHostId)
    }
  } catch (err) {
    return {
      session: null,
      issue: {
        executionHostId,
        agent: candidate.agent,
        path: candidate.file.path,
        ...scanIssueTextFromError(err)
      }
    }
  }
}

// Partial record loss is a notice because the transcript still appears in History.
function skippedRecordIssue(
  candidate: SessionFileCandidate,
  executionHostId: ExecutionHostId
): AiVaultScanIssue | null {
  const entry = getSessionParseCacheEntry(
    sessionParseCacheKey(candidate.agent, candidate.file.path)
  )
  const skipped = entry?.resume?.skippedRecords ?? entry?.skippedRecords
  const message = skipped ? describeSkippedTranscriptRecords(skipped) : null
  if (message === null) {
    return null
  }
  return {
    executionHostId,
    agent: candidate.agent,
    kind: 'notice',
    path: candidate.file.path,
    message
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
    id: `${executionHostId}:${session.agent}:${session.sessionId}:${session.filePath}`
  }
}
