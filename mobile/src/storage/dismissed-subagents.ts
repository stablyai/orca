import {
  parseDismissedSubagentStates,
  type DismissedSubagentStates
} from '../../../src/shared/native-chat/input/native-chat-subagent-dismissals'
import { persistMirrored, readMirroredKeyOrStore } from './mirrored-storage-keys'

export const DISMISSED_SUBAGENTS_STORAGE_PREFIX = 'orca:dismissedSubagents:'

const chains = new Map<string, Promise<void>>()

export function dismissedSubagentsStorageKey(hostId: string, worktreeId: string): string {
  return `${DISMISSED_SUBAGENTS_STORAGE_PREFIX}${encodeURIComponent(hostId)}:${encodeURIComponent(worktreeId)}`
}

type SessionDismissals = Record<string, DismissedSubagentStates>

function parseSessions(raw: string | null): SessionDismissals {
  if (!raw) {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {}
  }
  const sessions: SessionDismissals = {}
  for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (sessionId.length === 0 || sessionId.length > 256) {
      continue
    }
    sessions[sessionId] = parseDismissedSubagentStates(value)
  }
  return sessions
}

export function dismissedSubagentsInSession(
  raw: string | null,
  sessionId: string
): DismissedSubagentStates {
  return parseSessions(raw)[sessionId] ?? {}
}

export function writeDismissedSubagentSession(
  hostId: string,
  worktreeId: string,
  sessionId: string,
  dismissed: DismissedSubagentStates
): Promise<void> {
  const key = dismissedSubagentsStorageKey(hostId, worktreeId)
  const previous = chains.get(key) ?? Promise.resolve()
  const run = previous.then(async () => {
    const sessions = parseSessions(await readMirroredKeyOrStore(key))
    if (Object.keys(dismissed).length === 0) {
      delete sessions[sessionId]
    } else {
      sessions[sessionId] = dismissed
    }
    const json = JSON.stringify(sessions)
    await persistMirrored(key, Object.keys(sessions).length === 0 ? null : json)
  })
  const barrier = run.then(
    () => undefined,
    () => undefined
  )
  chains.set(key, barrier)
  return run
}
