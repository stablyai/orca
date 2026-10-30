import { basename, extname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type {
  AiVaultScanIssue,
  AiVaultSession,
  AiVaultSubagentListResult,
  AiVaultSubagentRunStatus
} from '../../shared/ai-vault-types'
import {
  CLAUDE_TASK_NOTIFICATION_MARKER,
  readClaudeTaskNotification
} from '../../shared/claude-task-notification-text'
import {
  openTranscriptReadStream,
  wslGatedReaddir,
  wslGatedReadFile,
  wslGatedStat
} from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { recordSessionScanIssue, scanIssueTextFromError } from './session-scan-issues'
import { sessionIdFromFileName, sessionSortTime } from './session-scanner-accumulator'
import { parseClaudeSessionFile } from './session-scanner-primary-parsers'
import {
  isSubagentTranscriptFileName,
  subagentTranscriptsDirFor,
  SUBAGENT_TRANSCRIPT_PREFIX
} from './session-scanner-subagent-transcripts'
import {
  asRecord,
  extractString,
  normalizeTitleText,
  parseJsonObject
} from './session-scanner-values'

// Without a terminal report, old transcripts have unknown status rather than remaining running.
const SUBAGENT_RUNNING_RECENCY_MS = 5 * 60_000
// Bound simultaneous streams to avoid stalling SSH/WSL reads.
const SUBAGENT_PARSE_CONCURRENCY = 8
// Bulk subagent reads use scan priority; reserve the exact lane for live transcript probes.
const SUBAGENT_FS_PRIORITY = 'scan'

const TOOL_USE_RESULT_MARKER = '"toolUseResult"'
// Require agentId to avoid decoding large ordinary tool outputs during the status pass.
const TOOL_USE_RESULT_AGENT_ID_MARKER = '"agentId"'

const TERMINAL_TASK_STATUSES: Record<string, AiVaultSubagentRunStatus> = {
  completed: 'completed',
  failed: 'failed',
  killed: 'stopped',
  stopped: 'stopped'
}

type ClaudeSubagentMeta = {
  description: string | null
  agentType: string | null
}

/** Read subagents on demand; the main History scan prunes their subtrees. */
export async function listClaudeSubagentSessions(args: {
  parentFilePath: string
  platform?: NodeJS.Platform
  now?: number
}): Promise<AiVaultSubagentListResult> {
  const platform = args.platform ?? process.platform
  const now = args.now ?? Date.now()
  const issues: AiVaultScanIssue[] = []
  const subagentsDir = subagentTranscriptsDirFor(args.parentFilePath)

  let entries
  try {
    entries = await wslGatedReaddir(subagentsDir, SUBAGENT_FS_PRIORITY)
  } catch (err) {
    // Surface WSL gate refusal so the panel can retry instead of reporting no subagents.
    if (err instanceof WslTranscriptFsError) {
      recordSessionScanIssue(issues, {
        agent: 'claude',
        path: subagentsDir,
        ...scanIssueTextFromError(err)
      })
    }
    return { sessions: [], issues }
  }

  const transcriptNames = entries
    .filter((entry) => isSubagentTranscriptFileName(entry.name, entry.isFile()))
    .map((entry) => entry.name)
  if (transcriptNames.length === 0) {
    return { sessions: [], issues }
  }

  const statusByAgentId = await collectSubagentTaskStatuses(args.parentFilePath)
  // Derive parent identity from the layout; missing subagent sessionId must not substitute its own filename.
  const parentSessionId = sessionIdFromFileName(args.parentFilePath)
  const parsed: (AiVaultSession | null)[] = []
  for (let index = 0; index < transcriptNames.length; index += SUBAGENT_PARSE_CONCURRENCY) {
    const batch = transcriptNames.slice(index, index + SUBAGENT_PARSE_CONCURRENCY)
    const batchResults = await Promise.all(
      batch.map((name) =>
        parseSubagentTranscript({
          filePath: join(subagentsDir, name),
          agentId: subagentIdFromFileName(name),
          parentSessionId,
          statusByAgentId,
          now,
          platform,
          issues
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

function subagentIdFromFileName(name: string): string {
  return basename(name, extname(name)).slice(SUBAGENT_TRANSCRIPT_PREFIX.length)
}

async function parseSubagentTranscript(args: {
  filePath: string
  agentId: string
  parentSessionId: string
  statusByAgentId: ReadonlyMap<string, string>
  now: number
  platform: NodeJS.Platform
  issues: AiVaultScanIssue[]
}): Promise<AiVaultSession | null> {
  try {
    const fileStat = await wslGatedStat(args.filePath, SUBAGENT_FS_PRIORITY)
    const session = await parseClaudeSessionFile(
      {
        path: args.filePath,
        mtimeMs: fileStat.mtimeMs,
        modifiedAt: fileStat.mtime.toISOString()
      },
      args.platform
    )
    if (!session) {
      return null
    }
    const meta = await readSubagentMeta(args.filePath)
    return {
      ...session,
      // Prefer the parent-assigned Task name over the raw prompt fallback.
      title: meta.description ?? session.title,
      subagent: {
        parentSessionId: args.parentSessionId,
        agentType: meta.agentType,
        status: resolveSubagentStatus({
          reportedStatus: args.statusByAgentId.get(args.agentId),
          mtimeMs: fileStat.mtimeMs,
          now: args.now
        })
      }
    }
  } catch (err) {
    recordSessionScanIssue(args.issues, {
      agent: 'claude',
      path: args.filePath,
      ...scanIssueTextFromError(err)
    })
    return null
  }
}

function resolveSubagentStatus(args: {
  reportedStatus: string | undefined
  mtimeMs: number
  now: number
}): AiVaultSubagentRunStatus | null {
  const terminal = args.reportedStatus ? TERMINAL_TASK_STATUSES[args.reportedStatus] : undefined
  if (terminal) {
    return terminal
  }
  // Without a terminal report, infer running only from recent transcript activity.
  return args.now - args.mtimeMs <= SUBAGENT_RUNNING_RECENCY_MS ? 'running' : null
}

// Sync Tasks use toolUseResult; background Tasks use notifications. The last reported status wins.
async function collectSubagentTaskStatuses(parentFilePath: string): Promise<Map<string, string>> {
  const statuses = new Map<string, string>()
  const input = openTranscriptReadStream(
    parentFilePath,
    { encoding: 'utf-8' },
    SUBAGENT_FS_PRIORITY
  )
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      const hasNotification = line.includes(CLAUDE_TASK_NOTIFICATION_MARKER)
      const hasTaskResult =
        line.includes(TOOL_USE_RESULT_MARKER) && line.includes(TOOL_USE_RESULT_AGENT_ID_MARKER)
      if (!hasNotification && !hasTaskResult) {
        continue
      }
      const record = parseJsonObject(line)
      if (!record) {
        continue
      }
      // Quoted markers must fall through to toolUseResult; verbatim leading notifications lack provenance to distinguish them.
      if (hasNotification) {
        const text = taskNotificationText(record)
        if (text.startsWith(CLAUDE_TASK_NOTIFICATION_MARKER)) {
          const notification = readClaudeTaskNotification(text)
          if (notification?.status) {
            statuses.set(notification.taskId, notification.status)
          }
          continue
        }
      }
      const result = asRecord(record.toolUseResult)
      const agentId = extractString(result?.agentId)
      const status = extractString(result?.status)
      if (agentId && status) {
        statuses.set(agentId, status)
      }
    }
  } catch {
    // A missing/unreadable parent transcript degrades to recency-only status.
  } finally {
    // readline.close() leaves its input open; destroy the gated stream even after read failures.
    lines.close()
    input.destroy()
  }
  return statuses
}

// Read full notification text: status can occur beyond title/preview truncation limits.
function taskNotificationText(record: Record<string, unknown>): string {
  const direct = extractString(record.content)
  if (direct) {
    return direct
  }
  const content = asRecord(record.message)?.content
  if (typeof content === 'string') {
    return content.trim()
  }
  if (Array.isArray(content)) {
    return content.map(taskNotificationBlockText).filter(Boolean).join(' ').trim()
  }
  return ''
}

function taskNotificationBlockText(block: unknown): string {
  if (typeof block === 'string') {
    return block
  }
  const record = asRecord(block)
  return extractString(record?.text) ?? extractString(record?.content) ?? ''
}

async function readSubagentMeta(transcriptPath: string): Promise<ClaudeSubagentMeta> {
  const metaPath = `${transcriptPath.slice(0, -extname(transcriptPath).length)}.meta.json`
  try {
    const raw = await wslGatedReadFile(metaPath, 'utf-8', SUBAGENT_FS_PRIORITY)
    const record = asRecord(JSON.parse(raw) as unknown)
    return {
      description: normalizeTitleText(extractString(record?.description) ?? ''),
      agentType: extractString(record?.agentType)
    }
  } catch {
    return { description: null, agentType: null }
  }
}
