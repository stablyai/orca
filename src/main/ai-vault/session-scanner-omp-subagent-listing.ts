import { basename, extname } from 'node:path'
import { createInterface } from 'node:readline'
import type {
  AiVaultScanIssue,
  AiVaultSession,
  AiVaultSubagentListResult,
  AiVaultSubagentRunStatus
} from '../../shared/ai-vault-types'
import { openTranscriptReadStream, wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { recordSessionScanIssue } from './session-scan-issues'
import { sessionIdFromFileName, sessionSortTime } from './session-scanner-accumulator'
import { createMessageGraphSessionResumeState } from './session-scanner-graph-parsers'
import { listOmpSubagentTranscriptPaths } from './session-scanner-omp-subagent-transcripts'
import {
  asRecord,
  errorMessage,
  extractString,
  parseJsonObject,
  timestampMs
} from './session-scanner-values'

// Match the Claude subagent lister's deliberate parse batching: opening every
// read stream at once stalls over WSL UNC paths.
const OMP_SUBAGENT_PARSE_CONCURRENCY = 8
// Bulk directory work, so 'scan' — same reasoning as the Claude lister.
const OMP_SUBAGENT_FS_PRIORITY = 'scan'
type OmpSubagentStatus = { status: AiVaultSubagentRunStatus; observedAt: number }

/**
 * List the task-subagent transcripts of one OMP session, on demand. The main
 * scan prunes session artifact directories for speed, so this is the only path
 * that reads them — and only when the user expands a session's details.
 * (Lives apart from session-scanner-omp-subagent-transcripts.ts so the graph
 * parser can import the count decorator without a parser↔lister import cycle —
 * the same split as Claude's transcripts/lister pair.)
 */
export async function listOmpSubagentSessions(args: {
  parentFilePath: string
  platform?: NodeJS.Platform
}): Promise<AiVaultSubagentListResult> {
  const platform = args.platform ?? process.platform
  const issues: AiVaultScanIssue[] = []
  let transcriptPaths
  try {
    transcriptPaths = await listOmpSubagentTranscriptPaths(args.parentFilePath)
  } catch (err) {
    recordSessionScanIssue(issues, {
      agent: 'omp',
      path: args.parentFilePath,
      message: errorMessage(err)
    })
    return { sessions: [], issues }
  }
  if (transcriptPaths.length === 0) {
    return { sessions: [], issues }
  }

  const { parentSessionId, statuses } = await readOmpSubagentStatuses(args.parentFilePath)
  const parsed: (AiVaultSession | null)[] = []
  for (let index = 0; index < transcriptPaths.length; index += OMP_SUBAGENT_PARSE_CONCURRENCY) {
    const batch = transcriptPaths.slice(index, index + OMP_SUBAGENT_PARSE_CONCURRENCY)
    const batchResults = await Promise.all(
      batch.map((filePath) =>
        parseOmpSubagentTranscript({
          filePath,
          parentSessionId,
          platform,
          issues,
          statuses
        })
      )
    )
    parsed.push(...batchResults)
  }

  return {
    sessions: parsed
      .filter((session): session is AiVaultSession => session !== null)
      .sort((left, right) => sessionSortTime(right) - sessionSortTime(left)),
    issues
  }
}

async function parseOmpSubagentTranscript(args: {
  filePath: string
  parentSessionId: string
  platform: NodeJS.Platform
  issues: AiVaultScanIssue[]
  statuses: ReadonlyMap<string, OmpSubagentStatus>
}): Promise<AiVaultSession | null> {
  const filePath = args.filePath
  try {
    const fileStat = await wslGatedStat(filePath, OMP_SUBAGENT_FS_PRIORITY)
    const state = createMessageGraphSessionResumeState('omp', {
      path: filePath,
      mtimeMs: fileStat.mtimeMs,
      modifiedAt: fileStat.mtime.toISOString()
    })
    const input = openTranscriptReadStream(
      filePath,
      { encoding: 'utf-8' },
      OMP_SUBAGENT_FS_PRIORITY
    )
    const lines = createInterface({ input, crlfDelay: Infinity })
    let messageCount = 0
    let agentType: string | null = null
    const turnStartedAts: number[] = []
    try {
      for await (const line of lines) {
        state.consumeLine(line)
        const record = parseJsonObject(line)
        if (record?.type === 'session_init') {
          agentType = extractString(record.agent) ?? agentType
        }
        if (record?.type !== 'message') {
          continue
        }
        const message = asRecord(record.message)
        if (message?.role === 'user') {
          const timestamp = timestampMs(record.timestamp)
          if (Number.isFinite(timestamp)) {
            turnStartedAts.push(timestamp)
          }
        }
        if (
          (message?.role === 'user' || message?.role === 'assistant') &&
          hasConversationText(message.content)
        ) {
          messageCount++
        }
      }
    } finally {
      lines.close()
      input.destroy()
    }
    const session = await state.finalize(args.platform)
    if (!session) {
      return null
    }
    const reported = args.statuses.get(basename(filePath, extname(filePath)))
    const latestTurn = turnStartedAts.at(-1)
    const reportedStatus =
      reported &&
      (reported.status === 'running' ||
        latestTurn === undefined ||
        !Number.isFinite(reported.observedAt) ||
        latestTurn <= reported.observedAt)
        ? reported.status
        : null
    return {
      ...session,
      messageCount,
      // Why: OMP names each child transcript after the task's label — the name
      // the coordinator gave it. That beats the transcript-derived fallback
      // (the raw task prompt).
      title: basename(filePath, extname(filePath)),
      subagent: {
        parentSessionId: args.parentSessionId,
        agentType,
        status: reportedStatus,
        ...(turnStartedAts.length > 0 ? { turnStartedAts } : {})
      }
    }
  } catch (err) {
    recordSessionScanIssue(args.issues, {
      agent: 'omp',
      path: filePath,
      message: errorMessage(err)
    })
    return null
  }
}

async function readOmpSubagentStatuses(
  parentFilePath: string
): Promise<{ parentSessionId: string; statuses: Map<string, OmpSubagentStatus> }> {
  const statuses = new Map<string, OmpSubagentStatus>()
  let parentSessionId = sessionIdFromFileName(parentFilePath)
  const input = openTranscriptReadStream(
    parentFilePath,
    { encoding: 'utf-8' },
    OMP_SUBAGENT_FS_PRIORITY
  )
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      const record = parseJsonObject(line)
      if (record?.type === 'session') {
        parentSessionId = extractString(record.id) ?? parentSessionId
      }
      if (record?.type !== 'message') {
        continue
      }
      const message = asRecord(record.message)
      if (message?.role !== 'toolResult' || message.toolName !== 'task') {
        continue
      }
      const details = asRecord(message.details)
      const observedAt = timestampMs(record.timestamp)
      for (const value of Array.isArray(details?.progress) ? details.progress : []) {
        const progress = asRecord(value)
        const id = extractString(progress?.id)
        const status = progress?.status
        if (
          id &&
          (status === 'running' ||
            status === 'completed' ||
            status === 'failed' ||
            status === 'aborted')
        ) {
          statuses.set(id, { status: status === 'aborted' ? 'stopped' : status, observedAt })
        }
      }
      for (const value of Array.isArray(details?.results) ? details.results : []) {
        const result = asRecord(value)
        const id = extractString(result?.id)
        if (!id || typeof result?.exitCode !== 'number') {
          continue
        }
        statuses.set(id, {
          status:
            result.aborted === true ? 'stopped' : result.exitCode === 0 ? 'completed' : 'failed',
          observedAt
        })
      }
    }
  } catch {
    // Parent may not have flushed yet; do not infer completion from a child's yield-aborted tail.
  } finally {
    lines.close()
    input.destroy()
  }
  return { parentSessionId, statuses }
}

function hasConversationText(content: unknown): boolean {
  return typeof content === 'string'
    ? content.trim().length > 0
    : Array.isArray(content) &&
        content.some((value) => {
          const block = asRecord(value)
          return (
            block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0
          )
        })
}
