// A chat paints a tail. The task pill needs the calls that happened before that tail.

import { stat } from 'node:fs/promises'
import type { AgentType } from '../../shared/agent-status/contracts/agent-status-types'
import type { NativeChatTaskSeedList } from '../../shared/native-chat/input/native-chat-claude-task-updates'
import { latestNativeChatTaskSeed } from '../../shared/native-chat/input/native-chat-task-seed'
import { foldToolMessages } from '../../shared/native-chat/tools/native-chat-tool-fold'
import { resolveSessionFilePath } from './session-file-resolver'
import { readNativeChatTranscript } from './transcript-reader'

type CacheEntry = { taskList: NativeChatTaskSeedList | null; mtimeMs: number; size: number }

const cache = new Map<string, CacheEntry>()

async function taskListFromFile(
  agent: AgentType,
  sessionId: string,
  filePath: string | undefined
): Promise<NativeChatTaskSeedList | null> {
  const read = await readNativeChatTranscript(agent, sessionId, filePath ? { filePath } : {})
  return 'error' in read ? null : latestNativeChatTaskSeed(foldToolMessages(read.messages))
}

/** Full-file task list, reused while the transcript file is unchanged. */
export async function scanNativeChatTranscriptTasks(
  agent: AgentType,
  sessionId: string,
  filePath?: string
): Promise<NativeChatTaskSeedList | null> {
  // A client-supplied hint is never trusted as-is; the tail read resolves it the same way.
  const resolved = await resolveSessionFilePath(
    agent,
    sessionId,
    filePath ? { transcriptPath: filePath } : {}
  ).catch(() => null)
  if (!resolved && !filePath) {
    // Agents without a resolvable local file read uncached.
    return taskListFromFile(agent, sessionId, undefined)
  }
  const info = resolved ? await stat(resolved).catch(() => null) : null
  if (!resolved || !info) {
    return null
  }
  const hit = cache.get(resolved)
  if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) {
    return hit.taskList
  }
  const taskList = await taskListFromFile(agent, sessionId, resolved)
  cache.set(resolved, { taskList, mtimeMs: info.mtimeMs, size: info.size })
  return taskList
}

/** Emit after the tail snapshot. An empty scan stays omitted so older clients see the same frames. */
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
