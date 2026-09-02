import { stat } from 'node:fs/promises'
import {
  createSessionParseStats,
  parseAgentSessionFileCached,
  type SessionParseStats
} from '../ai-vault/session-scanner-parse-cache'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'

// Transcript builders shared by the session-search store tests; each file owns
// its temp directories, this module only shapes records and drives the parser.

export const CLAUDE_SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
export const CODEX_SESSION_ID = '019f0000-1111-7222-8333-444444444444'
export const CODEX_ROLLOUT_FILE = `rollout-2026-05-01T10-00-00-${CODEX_SESSION_ID}.jsonl`

const RECORD_EPOCH_MS = 1740000000000

export function recordTimestamp(index: number): string {
  return new Date(RECORD_EPOCH_MS + index * 60_000).toISOString()
}

export function userRecord(index: number, content: unknown, sessionId = CLAUDE_SESSION_ID): string {
  return JSON.stringify({
    type: 'user',
    sessionId,
    timestamp: recordTimestamp(index),
    cwd: '/repo/app',
    gitBranch: 'main',
    message: { role: 'user', content }
  })
}

export function assistantRecord(
  index: number,
  content: unknown,
  sessionId = CLAUDE_SESSION_ID
): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    timestamp: recordTimestamp(index),
    message: { role: 'assistant', model: 'claude-fable-5', content }
  })
}

export async function sessionCandidate(
  agent: SessionFileCandidate['agent'],
  path: string,
  codexHome: string | null = null
): Promise<SessionFileCandidate> {
  const fileStat = await stat(path)
  return {
    agent,
    codexHome,
    file: {
      path,
      mtimeMs: fileStat.mtimeMs,
      modifiedAt: fileStat.mtime.toISOString(),
      sizeBytes: fileStat.size,
      dev: fileStat.dev,
      ino: fileStat.ino
    }
  }
}

export async function parseTranscript(
  path: string,
  agent: SessionFileCandidate['agent'] = 'claude',
  codexHome: string | null = null
): Promise<{ stats: SessionParseStats }> {
  const stats = createSessionParseStats()
  await parseAgentSessionFileCached(
    await sessionCandidate(agent, path, codexHome),
    process.platform,
    stats
  )
  return { stats }
}

function codexLine(record: Record<string, unknown>): string {
  return JSON.stringify(record)
}

/** Minimal Codex rollout: meta, one user message, one completed shell command. */
export function codexRolloutLines(command: string[], output: string, prompt: string): string[] {
  return [
    codexLine({
      timestamp: recordTimestamp(0),
      type: 'session_meta',
      payload: { id: CODEX_SESSION_ID, cwd: '/repo/app', git: { branch: 'main' } }
    }),
    codexLine({
      timestamp: recordTimestamp(1),
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: prompt }
    }),
    codexLine({
      timestamp: recordTimestamp(2),
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: { type: 'CommandExecution', command, aggregated_output: output }
      }
    })
  ]
}
