import { describe, expect, it } from 'vitest'
import type { MemorySnapshot } from '../../shared/diagnostics/process-stats-types'
import { recordPairedReplyParts, toPairedMemoryReply } from './memory-snapshot-paired-reply'

const chat = { agentSessionId: 'c1', agent: 'claude', name: 'Chat', cpu: 2, memory: 500 }
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reply reads only the fields set here.
const snapshot = {
  app: { cpu: 1, memory: 1_000, history: [1_000] },
  worktrees: [
    {
      worktreeId: 'repo::/mixed',
      worktreeName: 'mixed',
      repoId: 'repo',
      repoName: 'repo',
      cpu: 3,
      memory: 600,
      history: [600],
      terminalHistory: [100],
      sessions: [{ sessionId: 's1', paneKey: 'tab:1', pid: 7, cpu: 1, memory: 100 }],
      chats: [chat]
    },
    {
      worktreeId: 'repo::/chats',
      worktreeName: 'chats',
      repoId: 'repo',
      repoName: 'repo',
      cpu: 2,
      memory: 500,
      history: [500],
      sessions: [],
      chats: [chat]
    }
  ],
  agentProcesses: { cpu: 4, memory: 1_000 },
  totalCpu: 6,
  totalMemory: 2_100,
  collectedAt: 1
} as unknown as MemorySnapshot

describe('the memory snapshot a paired machine receives', () => {
  it('carries terminals only, with terminal totals, history and no restored pane keys', () => {
    recordPairedReplyParts(snapshot, {
      rowsDiffer: true,
      terminalSeries: [
        { worktreeId: 'repo::/mixed', usage: { cpu: 1, memory: 100, privateMemory: 0 } }
      ],
      hasPrivateMemory: false,
      restoredSessionIds: new Set(['s1']),
      totals: { totalCpu: 2, totalMemory: 1_100 }
    })

    expect(toPairedMemoryReply(snapshot)).toEqual({
      app: { cpu: 1, memory: 1_000, history: [1_000] },
      worktrees: [
        {
          worktreeId: 'repo::/mixed',
          worktreeName: 'mixed',
          repoId: 'repo',
          repoName: 'repo',
          cpu: 1,
          memory: 100,
          history: [100],
          sessions: [{ sessionId: 's1', paneKey: null, pid: 7, cpu: 1, memory: 100 }]
        }
      ],
      totalCpu: 2,
      totalMemory: 1_100,
      collectedAt: 1
    })
  })
})
