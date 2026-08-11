import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type {
  AiVaultScanIssue,
  AiVaultSession,
  AiVaultSubagentListResult,
  AiVaultSubagentRunStatus
} from '../../shared/ai-vault-types'
import { sessionIdFromFileName, sessionSortTime } from './session-scanner-accumulator'
import { parseClaudeSessionFile } from './session-scanner-primary-parsers'
import {
  isSubagentTranscriptFileName,
  subagentTranscriptsDirFor,
  SUBAGENT_TRANSCRIPT_PREFIX
} from './session-scanner-subagent-transcripts'
import {
  asRecord,
  errorMessage,
  extractString,
  normalizeTitleText,
  parseJsonObject
} from './session-scanner-values'

// A subagent writing nothing for this long without a terminal notification is
// treated as no longer running (its status stays unknown rather than stale).
const SUBAGENT_RUNNING_RECENCY_MS = 5 * 60_000
// Match the main scanner's deliberate parse batching (SESSION_PARSE_CONCURRENCY):
// opening every subagent read stream at once stalls over SSH/WSL UNC paths.
const SUBAGENT_PARSE_CONCURRENCY = 8

const TASK_NOTIFICATION_MARKER = '<task-notification>'
const TOOL_USE_RESULT_MARKER = '"toolUseResult"'
// A sync-Task toolUseResult sets a status only when it carries an agentId. Tool
// output records (Read/Bash) also carry "toolUseResult" and are the largest lines
// in a transcript, so gating on this second marker keeps the status pass from
// JSON-parsing ~all of the file's bytes on every on-demand fetch.
const TOOL_USE_RESULT_AGENT_ID_MARKER = '"agentId"'
const TASK_ID_PATTERN = /<task-id>([^<]+)<\/task-id>/
const TASK_STATUS_PATTERN = /<status>([a-z_]+)<\/status>/

// Statuses reported by parent-transcript <task-notification> records
// (background Tasks) and toolUseResult records (synchronous Tasks).
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

/**
 * List the Task subagent transcripts of one Claude session, on demand. The
 * main scan prunes `subagents/` subtrees for speed, so this is the only path
 * that reads them — and only when the user expands a session's details.
 */
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
    entries = await readdir(subagentsDir, { withFileTypes: true })
  } catch {
    return { sessions: [], issues }
  }

  const transcriptNames = entries
    .filter((entry) => isSubagentTranscriptFileName(entry.name, entry.isFile()))
    .map((entry) => entry.name)
  if (transcriptNames.length === 0) {
    return { sessions: [], issues }
  }

  // One pass over the parent transcript resolves every subagent's status.
  const statusByAgentId = await collectSubagentTaskStatuses(args.parentFilePath)
  // Why: the layout fixes the parent's sessionId (<parent>.jsonl -> subagents/);
  // deriving it here avoids a subagent transcript with no sessionId records
  // linking to its own filename-derived id instead of the parent.
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
    const fileStat = await stat(args.filePath)
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
      // Why: the spawn description is the name the main agent gave this Task;
      // it beats the transcript-derived fallback (the raw Task prompt).
      title: meta.description ?? session.title,
      subagent: {
        // The parent's sessionId is derived from its file path, not the
        // subagent transcript, so it survives transcripts with no sessionId.
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
    args.issues.push({ agent: 'claude', path: args.filePath, message: errorMessage(err) })
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
  // No terminal notification yet: a recently-written transcript is running;
  // a stale one has no trustworthy status (e.g. the parent was interrupted).
  return args.now - args.mtimeMs <= SUBAGENT_RUNNING_RECENCY_MS ? 'running' : null
}

// The parent transcript reports subagent completion in two shapes: sync Tasks
// finish with a toolUseResult record ({ agentId, status }); background Tasks
// launch with status 'async_launched' and finish with a <task-notification>
// whose <task-id> is the agentId. Last record wins, so interim statuses (e.g.
// 'async_launched', notification 'running') are superseded by terminal ones.
async function collectSubagentTaskStatuses(parentFilePath: string): Promise<Map<string, string>> {
  const statuses = new Map<string, string>()
  try {
    const lines = createInterface({
      input: createReadStream(parentFilePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity
    })
    for await (const line of lines) {
      const hasNotification = line.includes(TASK_NOTIFICATION_MARKER)
      const hasTaskResult =
        line.includes(TOOL_USE_RESULT_MARKER) && line.includes(TOOL_USE_RESULT_AGENT_ID_MARKER)
      if (!hasNotification && !hasTaskResult) {
        continue
      }
      const record = parseJsonObject(line)
      if (!record) {
        continue
      }
      // Only records whose text IS the notification set a status; a user prompt
      // (or a sync-Task toolUseResult report) that merely quotes one also trips
      // the raw-line prefilter, so it must not consume the record — fall through
      // to the toolUseResult branch below rather than dropping a real status.
      // Accepted limitation: a user message that BEGINS with a verbatim
      // notification is indistinguishable from a real delivery (records carry no
      // provenance marker), so it can set a bogus status. The impact is a wrong
      // dot on a view-only row, so we don't gate on user-type markers here (that
      // would risk dropping genuine harness-delivered statuses).
      if (hasNotification) {
        const text = taskNotificationText(record)
        if (text.startsWith(TASK_NOTIFICATION_MARKER)) {
          const taskId = TASK_ID_PATTERN.exec(text)?.[1]?.trim()
          const status = TASK_STATUS_PATTERN.exec(text)?.[1]
          if (taskId && status) {
            statuses.set(taskId, status)
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
  }
  return statuses
}

// The <status> marker follows <tool-use-id>/<output-file> lines in real
// notifications, so it sits well past the 96-char title cap — the notification
// text must be read untruncated (unlike titles/previews). Both delivery shapes
// appear: queue-operation records carry it as top-level `content`; user-message
// records under `message.content` (a string, or text content blocks).
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

// Claude writes an `agent-<id>.meta.json` sidecar for every subagent transcript,
// carrying the Task tool's spawn `description` and its resolved `agentType`.
async function readSubagentMeta(transcriptPath: string): Promise<ClaudeSubagentMeta> {
  const metaPath = `${transcriptPath.slice(0, -extname(transcriptPath).length)}.meta.json`
  try {
    const record = asRecord(JSON.parse(await readFile(metaPath, 'utf-8')) as unknown)
    return {
      description: normalizeTitleText(extractString(record?.description) ?? ''),
      agentType: extractString(record?.agentType)
    }
  } catch {
    // The sidecar is optional; the transcript still yields a usable title.
    return { description: null, agentType: null }
  }
}
