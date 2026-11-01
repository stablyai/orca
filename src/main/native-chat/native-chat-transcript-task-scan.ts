// A chat paints a tail. The pills need the calls that happened before that tail.

import { stat } from 'node:fs/promises'
import type { AgentType } from '../../shared/agent-status-types'
import {
  latestNativeChatTaskSeed,
  nativeChatSubagentActivities,
  type NativeChatSubagentActivity
} from '../../shared/native-chat/input/native-chat-activity'
import type { NativeChatTaskSeedList } from '../../shared/native-chat/input/native-chat-claude-task-updates'
import { projectNativeChatTranscript } from '../../shared/native-chat/transcript/native-chat-transcript-projection'
import { foldToolMessages } from '../../shared/native-chat/tools/native-chat-tool-fold'
import { readNativeChatTranscript } from './transcript-reader'
import { fillSubagentRosterActivity } from './transcript-subagent-roster-activity'

export type NativeChatTranscriptActivitySeed = {
  taskList: NativeChatTaskSeedList | null
  subagents: readonly NativeChatSubagentActivity[] | null
}

type CacheEntry = NativeChatTranscriptActivitySeed & { mtimeMs: number; size: number }

const cache = new Map<string, CacheEntry>()

function emptySeed(): NativeChatTranscriptActivitySeed {
  return { taskList: null, subagents: null }
}

async function seedFromFile(
  agent: AgentType,
  sessionId: string,
  filePath: string | undefined
): Promise<NativeChatTranscriptActivitySeed> {
  const read = await readNativeChatTranscript(agent, sessionId, filePath ? { filePath } : {})
  if ('error' in read) {
    return emptySeed()
  }
  const taskList = latestNativeChatTaskSeed(foldToolMessages(read.messages))
  const projection = projectNativeChatTranscript(read.messages)
  const roster = nativeChatSubagentActivities(projection.conversation, projection.subagentRows)
  const subagents = await fillSubagentRosterActivity(agent, filePath, roster)
  return { taskList, subagents: subagents.length > 0 ? subagents : null }
}

/** Full-file task list and subagent roster, reused while the transcript file is unchanged. */
export async function scanNativeChatTranscriptActivity(
  agent: AgentType,
  sessionId: string,
  filePath?: string
): Promise<NativeChatTranscriptActivitySeed> {
  if (!filePath) {
    return seedFromFile(agent, sessionId, undefined)
  }
  const info = await stat(filePath).catch(() => null)
  if (!info) {
    return emptySeed()
  }
  const hit = cache.get(filePath)
  if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) {
    return { taskList: hit.taskList, subagents: hit.subagents }
  }
  const seed = await seedFromFile(agent, sessionId, filePath)
  cache.set(filePath, { mtimeMs: info.mtimeMs, size: info.size, ...seed })
  return seed
}

/** Full-file task list, reused while the transcript file is unchanged. */
export async function scanNativeChatTranscriptTasks(
  agent: AgentType,
  sessionId: string,
  filePath?: string
): Promise<NativeChatTaskSeedList | null> {
  return (await scanNativeChatTranscriptActivity(agent, sessionId, filePath)).taskList
}

/** Emit after the tail snapshot. An empty scan stays omitted so older clients see the same frames. */
export function publishTranscriptTaskList(args: {
  agent: AgentType
  sessionId: string
  filePath?: string
  stillCurrent: () => boolean
  emit: (seed: NativeChatTranscriptActivitySeed) => void
}): void {
  void scanNativeChatTranscriptActivity(args.agent, args.sessionId, args.filePath)
    .then((seed) => {
      if (args.stillCurrent() && (seed.taskList || seed.subagents)) {
        args.emit(seed)
      }
    })
    .catch(() => undefined)
}
