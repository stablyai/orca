import { join } from 'node:path'

import { readAgentEffortLevel } from '../../../shared/agent-launch/choices/agent-effort-level'
import { claudeSubagentTranscriptPath } from '../../../shared/agent-hook-listener/providers/claude/transcripts/claude-subagent-transcript-path'
import { isRecord } from '../../../shared/agent-status/child-work/agent-status-child-work-value-guards'
import {
  openTranscriptReadStream,
  wslGatedStat
} from '../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import { resolveSessionFilePath } from '../../native-chat/session-file-resolver'
import type { ClaudeSession } from '../structured/claude-structured-session-state'

/** Effort sits on the last assistant rows, so one tail read finds it. */
const SUBAGENT_EFFORT_TAIL_BYTES = 1024 * 1024

/** A prompt that starts a run, unlike tool results, meta rows and interruption markers. */
function isRunPrompt(row: Record<string, unknown>): boolean {
  if (row.type !== 'user' || row.isMeta === true || !isRecord(row.message)) {
    return false
  }
  const content = row.message.content
  if (typeof content === 'string') {
    return true
  }
  return (
    Array.isArray(content) &&
    content.some(
      (block) =>
        isRecord(block) &&
        block.type === 'text' &&
        typeof block.text === 'string' &&
        !block.text.startsWith('[Request interrupted')
    ) &&
    !content.some((block) => isRecord(block) && block.type === 'tool_result')
  )
}

/** The last effort Claude resolved for the latest subagent run that wrote these rows. */
export function claudeTranscriptEffort(text: string): string | undefined {
  let effort: string | undefined
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue
    }
    let row: Record<string, unknown> | null = null
    try {
      const value: unknown = JSON.parse(line)
      row = isRecord(value) ? value : null
    } catch {
      // A tail read can start or end mid-row.
      continue
    }
    if (row && isRunPrompt(row)) {
      // A resumed run appends to the same file; only rows after its prompt describe it.
      effort = undefined
      continue
    }
    if (row?.type !== 'assistant') {
      continue
    }
    const level = readAgentEffortLevel(row.effort) ?? readAgentEffortLevel(row.perTurnEffort)
    if (level !== undefined) {
      effort = level
    }
  }
  return effort
}

/** Read one subagent's transcript; a missing or unreadable file proves nothing rather than a level. */
export async function readClaudeSubagentTranscriptEffort(input: {
  sessionTranscriptPath: string
  agentId: string
  signal?: AbortSignal
}): Promise<string | undefined> {
  const transcriptPath = claudeSubagentTranscriptPath(input.sessionTranscriptPath, input.agentId)
  if (!transcriptPath) {
    return undefined
  }
  try {
    const stat = await wslGatedStat(transcriptPath, 'scan', input.signal)
    const chunks: string[] = []
    const stream = openTranscriptReadStream(
      transcriptPath,
      {
        start: Math.max(0, stat.size - SUBAGENT_EFFORT_TAIL_BYTES),
        encoding: 'utf-8'
      },
      'scan',
      input.signal
    )
    for await (const chunk of stream) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    }
    return claudeTranscriptEffort(chunks.join(''))
  } catch {
    return undefined
  }
}

const sessionTranscriptPaths = new WeakMap<ClaudeSession, Promise<string | null>>()

/** Where Claude wrote this process's session transcript, from the account and folder it launched in. */
function claudeSessionTranscriptPath(session: ClaudeSession): Promise<string | null> {
  const cached = sessionTranscriptPaths.get(session)
  if (cached) {
    return cached
  }
  const pending = resolveSessionFilePath('claude', session.providerSessionId, {
    claudeProjectsDir: join(session.initialization.claudeConfigDir, 'projects'),
    cwd: session.initialization.cwd
  })
    .catch(() => null)
    .then((path) => {
      // A transcript that lands after the first probe must be found by the next one.
      if (path === null) {
        sessionTranscriptPaths.delete(session)
      }
      return path
    })
  sessionTranscriptPaths.set(session, pending)
  return pending
}

/** The effort a Claude subagent's own transcript resolved, never the parent's. */
export function readClaudeSubagentEffort(
  session: ClaudeSession,
  agentId: string
): Promise<string | undefined> {
  return claudeSessionTranscriptPath(session).then((path) =>
    path === null
      ? undefined
      : readClaudeSubagentTranscriptEffort({ sessionTranscriptPath: path, agentId })
  )
}
