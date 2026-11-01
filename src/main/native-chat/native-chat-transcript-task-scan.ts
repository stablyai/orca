// A chat paints a tail. The task pill needs the calls that happened before that tail.

import { stat } from 'node:fs/promises'
import type { AgentType } from '../../shared/agent-status-types'
import { latestNativeChatTaskSeed } from '../../shared/native-chat/input/native-chat-activity'
import type { NativeChatTaskSeedList } from '../../shared/native-chat/input/native-chat-claude-task-updates'
import { foldToolMessages } from '../../shared/native-chat/tools/native-chat-tool-fold'
import { readNativeChatTranscript } from './transcript-reader'

type CacheEntry = { mtimeMs: number; size: number; taskList: NativeChatTaskSeedList | null }

const cache = new Map<string, CacheEntry>()

async function seedFromFile(
  agent: AgentType,
  sessionId: string,
  filePath: string | undefined
): Promise<NativeChatTaskSeedList | null> {
  const read = await readNativeChatTranscript(agent, sessionId, filePath ? { filePath } : {})
  if ('error' in read) {
    return null
  }
  return latestNativeChatTaskSeed(foldToolMessages(read.messages))
}

/** Full-file task list, reused while the transcript file is unchanged. */
export async function scanNativeChatTranscriptTasks(
  agent: AgentType,
  sessionId: string,
  filePath?: string
): Promise<NativeChatTaskSeedList | null> {
  if (!filePath) {
    return seedFromFile(agent, sessionId, undefined)
  }
  const info = await stat(filePath).catch(() => null)
  if (!info) {
    return null
  }
  const hit = cache.get(filePath)
  if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) {
    return hit.taskList
  }
  const taskList = await seedFromFile(agent, sessionId, filePath)
  cache.set(filePath, { mtimeMs: info.mtimeMs, size: info.size, taskList })
  return taskList
}

/** Emit after the tail snapshot. A null list stays omitted so older clients see the same frames. */
export function publishTranscriptTaskList(args: {
  agent: AgentType
  sessionId: string
  filePath?: string
  stillCurrent: () => boolean
  emit: (taskList: NativeChatTaskSeedList) => void
}): void {
  void scanNativeChatTranscriptTasks(args.agent, args.sessionId, args.filePath)
    .then((taskList) => {
      if (args.stillCurrent() && taskList) {
        args.emit(taskList)
      }
    })
    .catch(() => undefined)
}
