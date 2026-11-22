import { describe, expect, it } from 'vitest'
import { chatInclusiveHistoryKey, readMemoryHistory } from './memory-snapshot-buckets'
import type { WorktreeMemoryBucket } from './memory-snapshot-buckets'
import { readWorkspaceHistory, recordWorkspaceMemorySeries } from './workspace-memory-series'

const ID = 'repo::/series'
const chat = { agentSessionId: 'c', agent: 'claude', name: null, cpu: 0, memory: 600 }
const terminal = { sessionId: 's', paneKey: null, pid: 1, cpu: 0, memory: 0 }

function sample(terminalMemory: number | null, withChat: boolean, now: number): void {
  const bucket: WorktreeMemoryBucket = {
    worktreeId: ID,
    worktreeName: 'series',
    repoId: 'repo',
    repoName: 'repo',
    cpu: 0,
    memory: (terminalMemory ?? 0) + (withChat ? 600 : 0),
    privateMemory: 0,
    sessions: terminalMemory === null ? [] : [{ ...terminal, memory: terminalMemory }],
    ...(withChat ? { chats: [chat] } : {})
  }
  const terminalUsage = new Map(
    withChat && terminalMemory !== null
      ? [[ID, { cpu: 0, memory: terminalMemory, privateMemory: 0 }]]
      : []
  )
  recordWorkspaceMemorySeries([bucket], terminalUsage, now)
}

describe('workspace memory series', () => {
  it('keeps terminal samples alone in the plain series and gives the row a chat-inclusive one', () => {
    sample(100, false, 1)
    sample(null, true, 2)
    sample(120, true, 3)

    expect(readMemoryHistory(ID)).toEqual([100, 120])
    expect(readWorkspaceHistory(ID)).toEqual([100, 600, 720])

    // The chat's peak stays in the row's graph after it ends, as a stopped process's always did.
    sample(130, false, 4)
    expect(readMemoryHistory(ID)).toEqual([100, 120, 130])
    expect(readWorkspaceHistory(ID)).toEqual([100, 600, 720, 130])

    recordWorkspaceMemorySeries([], new Map(), 5)
    expect(readMemoryHistory(chatInclusiveHistoryKey(ID))).toEqual([])
  })
})
