// A chat paints a tail. The subagent pill needs the spawns that happened before that tail.

import type { AgentType } from '../../shared/agent-status/contracts/agent-status-types'
import {
  nativeChatSubagentActivities,
  type NativeChatSubagentActivity
} from '../../shared/native-chat/input/native-chat-activity'
import { projectNativeChatTranscript } from '../../shared/native-chat/transcript/native-chat-transcript-projection'
import { readNativeChatTranscript } from './transcript-reader'
import { resolveSessionFilePath } from './session-file-resolver'
import { toHostReadableTranscriptPath } from './host-readable-transcript-path'
import { transcriptFileStat } from './wsl-transcript-fs-access'
import { fillSubagentRosterActivity } from './transcript-subagent-roster-activity'

export type NativeChatTranscriptActivitySeed = {
  subagents: readonly NativeChatSubagentActivity[] | null
}

type ParentRoster = readonly NativeChatSubagentActivity[]
type CacheEntry = { mtimeMs: number; size: number; roster: ParentRoster }

// Only the parent file is cached; child previews are refreshed on every scan.
const MAX_CACHED_ROSTERS = 32
const cache = new Map<string, CacheEntry>()
// Viewers of one transcript share a parent parse instead of each reading the whole file.
const inFlight = new Map<string, Promise<ParentRoster | null>>()

function rememberRoster(filePath: string, entry: CacheEntry): void {
  cache.delete(filePath)
  cache.set(filePath, entry)
  if (cache.size > MAX_CACHED_ROSTERS) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) {
      cache.delete(oldest)
    }
  }
}

function sharedParentRoster(
  agent: AgentType,
  sessionId: string,
  filePath: string,
  stamp: string
): Promise<ParentRoster | null> {
  const key = `${filePath}\t${stamp}`
  const pending = inFlight.get(key)
  if (pending) {
    return pending
  }
  const started = parentRosterFromFile(agent, sessionId, filePath).finally(() =>
    inFlight.delete(key)
  )
  inFlight.set(key, started)
  return started
}
const latestScan = new Map<string, number>()
let scanCounter = 0

function emptySeed(): NativeChatTranscriptActivitySeed {
  return { subagents: null }
}

async function parentRosterFromFile(
  agent: AgentType,
  sessionId: string,
  filePath: string
): Promise<ParentRoster | null> {
  const read = await readNativeChatTranscript(agent, sessionId, { filePath })
  if ('error' in read) {
    return null
  }
  const projection = projectNativeChatTranscript(read.messages)
  return nativeChatSubagentActivities(projection.conversation, projection.subagentRows)
}

async function withChildActivity(
  agent: AgentType,
  filePath: string | undefined,
  roster: ParentRoster
): Promise<NativeChatTranscriptActivitySeed> {
  const subagents = await fillSubagentRosterActivity(agent, filePath, roster)
  return { subagents: subagents.length > 0 ? subagents : null }
}

/** Full-file subagent roster; the parent parse is reused while the transcript file is unchanged. */
export async function scanNativeChatTranscriptActivity(
  agent: AgentType,
  sessionId: string,
  guestFilePath?: string
): Promise<NativeChatTranscriptActivitySeed> {
  // WSL guest paths are not host-readable; stat, read and cache all use the translated path.
  const filePath = guestFilePath
    ? await toHostReadableTranscriptPath(guestFilePath).catch(() => null)
    : await resolveSessionFilePath(agent, sessionId, {}).catch(() => null)
  if (!filePath) {
    return emptySeed()
  }
  const info = await transcriptFileStat(filePath, 'exact').catch(() => null)
  if (!info) {
    return emptySeed()
  }
  const hit = cache.get(filePath)
  if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) {
    rememberRoster(filePath, hit)
    return withChildActivity(agent, filePath, hit.roster)
  }
  const roster = await sharedParentRoster(
    agent,
    sessionId,
    filePath,
    `${info.mtimeMs}:${info.size}`
  )
  if (!roster) {
    return emptySeed()
  }
  rememberRoster(filePath, { mtimeMs: info.mtimeMs, size: info.size, roster })
  return withChildActivity(agent, filePath, roster)
}

/** Emit after the tail snapshot. An empty scan stays omitted so older clients see the same frames. */
export function publishTranscriptSubagents(args: {
  agent: AgentType
  sessionId: string
  filePath?: string
  // A newer scan for the same key retires this one, so a slow old read cannot restore an old roster.
  fenceKey: string
  stillCurrent: () => boolean
  emit: (subagents: readonly NativeChatSubagentActivity[]) => void
}): void {
  const generation = ++scanCounter
  latestScan.set(args.fenceKey, generation)
  void scanNativeChatTranscriptActivity(args.agent, args.sessionId, args.filePath)
    .then((seed) => {
      const latest = latestScan.get(args.fenceKey) === generation
      if (latest) {
        latestScan.delete(args.fenceKey)
      }
      if (latest && args.stillCurrent() && seed.subagents) {
        args.emit(seed.subagents)
      }
    })
    .catch(() => {
      if (latestScan.get(args.fenceKey) === generation) {
        latestScan.delete(args.fenceKey)
      }
    })
}
