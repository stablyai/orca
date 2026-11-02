import { useEffect, useState } from 'react'
import {
  readNativeChatTaskSeedList,
  type NativeChatTaskSeedList
} from '../../../../src/shared/native-chat/input/native-chat-claude-task-updates'
import type { RpcClient } from '../../transport/rpc-client'
import { nativeChatSessionPageRead } from '../mobile-session-read-operations'

function taskListField(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || !('taskList' in value)) {
    return null
  }
  return value.taskList
}

/** One full-file read for a structured chat whose journal window does not hold the tasks. */
export function useMobileTranscriptTaskList(args: {
  client: RpcClient | null
  agent: string | null
  sessionId: string | null
  transcriptPath: string | null
}): NativeChatTaskSeedList | null {
  const { client, agent, sessionId, transcriptPath } = args
  const key = client && agent && sessionId ? `${agent}\0${sessionId}\0${transcriptPath ?? ''}` : ''
  const [seed, setSeed] = useState<{ key: string; taskList: NativeChatTaskSeedList | null } | null>(
    null
  )
  useEffect(() => {
    if (!client || !agent || !sessionId || !key) {
      return
    }
    let cancelled = false
    void nativeChatSessionPageRead
      .request(
        client,
        {
          agent,
          sessionId,
          limit: 1,
          capabilities: { taskList: 1 },
          ...(transcriptPath ? { transcriptPath } : {})
        },
        { timeoutMs: 120_000, budgetSpansConnect: true }
      )
      .then((response) => {
        if (cancelled) {
          return
        }
        const accepted = nativeChatSessionPageRead.interpret(response)
        setSeed({
          key,
          taskList: accepted.accepted
            ? readNativeChatTaskSeedList(taskListField(accepted.value))
            : null
        })
      })
      .catch(() => {
        if (!cancelled) {
          setSeed({ key, taskList: null })
        }
      })
    return () => {
      cancelled = true
    }
  }, [agent, client, key, sessionId, transcriptPath])
  return seed?.key === key ? seed.taskList : null
}
