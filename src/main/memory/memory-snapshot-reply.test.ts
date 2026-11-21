import { describe, expect, it } from 'vitest'
import type { MemorySnapshot, WorktreeMemory } from '../../shared/diagnostics/process-stats-types'
import { toMemorySnapshotReply } from './memory-snapshot-reply'

const MIB4 = 4 * 1024 * 1024

function snapshotOf(worktrees: WorktreeMemory[], history: number[] = []): MemorySnapshot {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reply reads only the fields set here.
  return {
    app: { cpu: 1.5, memory: 1_000, main: {}, renderer: {}, other: {}, history },
    worktrees,
    agentProcesses: { cpu: 0.3, memory: 500 },
    totalCpu: 1.8,
    totalMemory: 1_500
  } as unknown as MemorySnapshot
}

function row(i: number, idBytes: number, history: number[], withChat: boolean): WorktreeMemory {
  return {
    worktreeId: `w-${i}-${'x'.repeat(idBytes)}`,
    worktreeName: 'main',
    repoId: 'repo',
    repoName: 'repo',
    cpu: withChat ? 0.30000000000000004 : 0.1,
    memory: withChat ? 300 : 100,
    sessions: [
      {
        sessionId: `pty-${i}-${'x'.repeat(idBytes)}`,
        paneKey: `tab-${i}:leaf-0123456789abcdef0123456789abcdef`,
        pid: 1_000 + i,
        cpu: 0.1,
        memory: 100
      }
    ],
    ...(withChat
      ? {
          chats: [
            { agentSessionId: `chat-${i}`, agent: 'claude', name: 'Plan', cpu: 0.2, memory: 200 }
          ]
        }
      : {}),
    history
  }
}

describe('the memory snapshot sent over RPC', () => {
  it('is the snapshot itself when it fits, with its full history', () => {
    const history = Array.from({ length: 60 }, (_, i) => i + 1)
    const snapshot = snapshotOf([row(0, 10, history, true)], history)

    expect(toMemorySnapshotReply(snapshot)).toBe(snapshot)
  })

  it('keeps every row and 20 history points when the full history would not fit', () => {
    const history = Array.from({ length: 60 }, () => 123_456_789_012)
    const worktrees = Array.from({ length: 2_000 }, (_, i) => row(i, 300, history, false))

    const reply = toMemorySnapshotReply(snapshotOf(worktrees, history))

    expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThan(MIB4)
    expect(reply.worktrees).toHaveLength(2_000)
    expect(reply.worktrees[1_999]?.history).toHaveLength(20)
    expect(reply.app.history).toHaveLength(20)
  })

  it("falls back to the terminals' own rows and totals before it would outgrow them", () => {
    const terminals = Array.from({ length: 4_000 }, (_, i) =>
      row(i, 300, [123_456_789], i % 2 === 0)
    )
    const chatOnly: WorktreeMemory = {
      ...row(9_999, 10, [1], true),
      sessions: [],
      cpu: 0.2,
      memory: 200
    }

    const reply = toMemorySnapshotReply(snapshotOf([...terminals, chatOnly], [1, 2]))

    expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThan(MIB4)
    expect(reply.worktrees).toHaveLength(4_000)
    expect(reply.worktrees[0]).toMatchObject({ cpu: 0.1, memory: 100, history: [] })
    expect(reply.worktrees[0]?.chats).toBeUndefined()
    expect(reply.worktrees[0]?.sessions[0]?.paneKey).toBeNull()
    expect(reply.agentProcesses).toBeUndefined()
    expect(reply.totalMemory).toBe(1_000 + 4_000 * 100)
  })
})
