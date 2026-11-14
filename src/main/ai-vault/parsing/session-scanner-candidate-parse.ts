import { isTranscriptSourceFailure } from './session-scanner-jsonl-reader'
import {
  physicalSessionCandidates,
  type SessionFileCandidate,
  type SessionFileChoice,
  type SessionParseResult
} from '../session-scanner-types'
import { yieldToEventLoop } from '../../../shared/event-loop-yield'
import { isTextTaskRequestSession } from './text-task-request-sessions'
import { candidateFileTime } from '../scanners/antigravity/antigravity-transcript-candidates'
import {
  aiVaultAgentLabel,
  isAiVaultSessionResumableContent,
  isAiVaultSessionRecoverableEmpty,
  type AiVaultScanIssue,
  type AiVaultSession
} from '../../../shared/ai-vault/contracts/ai-vault-types'
import { aiVaultScanIssueText } from '../../../shared/ai-vault/scanning/ai-vault-scan-issue-copy'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { ScannedSessionCollection } from './session-root-dedup'
import type { AntigravityWorkspaceResolver } from '../scanners/antigravity/session-scanner-antigravity-history'
import {
  parseAgentSessionFileCached,
  parseListedSessionFile,
  type SessionParseStats
} from '../parse-cache/session-scanner-parse-cache'
import { recordSessionScanIssue, scanIssueTextFromError } from './session-scan-issues'
import {
  getSessionParseCacheEntry,
  noteSessionParseCacheListed,
  sessionParseCacheKey
} from '../parse-cache/session-parse-cache-store'
import { canStopParsingSessions } from './session-scan-cutoff'
import { throwIfAiVaultScanCancelled } from '../scan-lifecycle/ai-vault-scan-cancellation'
import { noteAiVaultScanWorkChanged } from '../scan-lifecycle/ai-vault-scan-progress'

const SESSION_PARSE_CONCURRENCY = 8

export async function parseSessionCandidates(args: {
  candidates: SessionFileChoice[]
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
    const results = await Promise.all(
      batch.map(async (choice) => {
        const issues: AiVaultScanIssue[] = []
        let selected = false
        let provisional: { candidate: SessionFileCandidate; session: AiVaultSession } | undefined
        let accepted: typeof provisional
        for (const candidate of physicalSessionCandidates(choice)) {
          throwIfAiVaultScanCancelled(args.signal)
          if (args.selectCandidate && !(await args.selectCandidate(candidate))) {
            continue
          }
          selected = true
          const result = await parseSessionCandidate(candidate, {
            platform: args.platform,
            executionHostId: args.executionHostId,
            parseStats: args.parseStats,
            antigravityWorkspaceResolver: args.antigravityWorkspaceResolver,
            listed: args.listed ?? true,
            signal: args.signal
          })
          throwIfAiVaultScanCancelled(args.signal)
          if (result.issue) {
            issues.push(result.issue)
          }
          if (result.sourceFailed) {
            continue
          }
          if (!result.session && result.issue) {
            break
          }
          if (!result.session || isTextTaskRequestSession(result.session)) {
            provisional = undefined
            break
          }
          if (args.admitSession && !args.admitSession(result.session)) {
            continue
          }
          const parsed = { candidate, session: result.session }
          if (
            isAiVaultSessionResumableContent(result.session) ||
            isAiVaultSessionRecoverableEmpty(result.session)
          ) {
            accepted = parsed
            break
          }
          provisional ??= parsed
        }
        throwIfAiVaultScanCancelled(args.signal)
        return { winner: accepted ?? provisional, selected, issues }
      })
    )
    throwIfAiVaultScanCancelled(args.signal)
    results.forEach(({ winner, selected, issues }, index) => {
      for (const issue of issues) {
        recordSessionScanIssue(args.issues, issue)
      }
      if (winner) {
        if (args.listed === false) {
          const { agent, file } = winner.candidate
          noteSessionParseCacheListed(sessionParseCacheKey(agent, file.path))
        }
        sessions.add(winner.session)
      }
      args.settled?.(batch[index], selected)
    })
    noteAiVaultScanWorkChanged(args.signal)
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
      issue: unreadableTranscriptIssue(candidate, session, executionHostId)
    }
  } catch (err) {
    return {
      session: null,
      sourceFailed: isTranscriptSourceFailure(err),
      issue: {
        executionHostId,
        agent: candidate.agent,
        path: candidate.file.path,
        ...scanIssueTextFromError(err)
      }
    }
  }
}

// A filename-derived row does not prove that any conversation was read.
function unreadableTranscriptIssue(
  candidate: SessionFileCandidate,
  session: AiVaultSession | null,
  executionHostId: ExecutionHostId
): AiVaultScanIssue | null {
  if (
    !session ||
    isAiVaultSessionResumableContent(session) ||
    isAiVaultSessionRecoverableEmpty(session)
  ) {
    return null
  }
  const entry = getSessionParseCacheEntry(
    sessionParseCacheKey(candidate.agent, candidate.file.path)
  )
  const skipped = entry?.resume?.skippedRecords ?? entry?.skippedRecords
  if (!skipped?.length) {
    return null
  }
  return {
    executionHostId,
    agent: candidate.agent,
    path: candidate.file.path,
    // Name the parsed writer: a shared discovery root (OMP files under Pi's) can differ from it.
    ...aiVaultScanIssueText('transcriptTooLarge', {
      params: { label: aiVaultAgentLabel(session.agent) }
    })
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
