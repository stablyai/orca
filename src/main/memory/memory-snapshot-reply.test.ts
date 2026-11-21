import { describe, expect, it } from 'vitest'
import type { MemorySnapshot } from '../../shared/diagnostics/process-stats-types'
import { toMemorySnapshotReply } from './memory-snapshot-reply'

describe('the memory snapshot sent over RPC', () => {
  it('keeps every row but only its 20 most recent history points', () => {
    const history = Array.from({ length: 60 }, (_, i) => i + 1)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reply reads only app and worktree histories.
    const snapshot = {
      app: { cpu: 0, memory: 0, main: {}, renderer: {}, other: {}, history },
      worktrees: Array.from({ length: 4_000 }, (_, i) => ({
        worktreeId: `w${i}`,
        sessions: [],
        history
      }))
    } as unknown as MemorySnapshot

    const reply = toMemorySnapshotReply(snapshot)

    expect(reply.app.history).toEqual([
      41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60
    ])
    expect(reply.worktrees).toHaveLength(4_000)
    expect(reply.worktrees.every((worktree) => worktree.history.length === 20)).toBe(true)
    expect(reply.worktrees[3_999]?.history.at(-1)).toBe(60)
  })

  it('leaves out history, then chat detail, before a large host would exceed the size limit', () => {
    const history = Array.from({ length: 60 }, () => 123_456_789)
    const id = (prefix: string, i: number): string => `${prefix}-${i}-${'x'.repeat(330)}`
    const worktrees = Array.from({ length: 4_000 }, (_, i) => ({
      worktreeId: id('w', i),
      worktreeName: 'main',
      repoId: 'repo',
      repoName: 'repo',
      cpu: 1,
      memory: 123_456_789,
      sessions: [
        { sessionId: id('pty', i), paneKey: null, pid: 1_000 + i, cpu: 1, memory: 123_456_789 }
      ],
      ...(i % 4 === 0
        ? {
            chats: [
              {
                agentSessionId: '2015f7a9-8b8c-4018-8466-92a245c1f0fb',
                agent: 'claude',
                name: 'n'.repeat(50),
                cpu: 1,
                memory: 123_456_789
              }
            ]
          }
        : {}),
      history
    }))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reply reads only app and worktrees.
    const snapshot = {
      app: { cpu: 0, memory: 0, main: {}, renderer: {}, other: {}, history },
      worktrees
    } as unknown as MemorySnapshot

    const reply = toMemorySnapshotReply(snapshot)

    expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThan(4 * 1024 * 1024)
    expect(reply.worktrees).toHaveLength(4_000)
    expect(reply.worktrees[3_999]?.sessions).toHaveLength(1)
  })

  it('leaves out chat-only rows before terminal rows when even those would not fit', () => {
    const id = (prefix: string, i: number): string =>
      `${prefix}-${i}-${'"'.repeat(160)}${'x'.repeat(90)}`
    const terminal = Array.from({ length: 3_500 }, (_, i) => ({
      worktreeId: id('w', i),
      worktreeName: 'main',
      repoId: 'repo',
      repoName: 'repo',
      cpu: 1,
      memory: 123_456_789,
      sessions: [
        { sessionId: id('pty', i), paneKey: null, pid: 1_000 + i, cpu: 1, memory: 123_456_789 }
      ],
      history: [123_456_789]
    }))
    const chatOnly = Array.from({ length: 1_400 }, (_, i) => ({
      worktreeId: id('chat-w', i),
      worktreeName: 'main',
      repoId: 'repo',
      repoName: 'repo',
      cpu: 1,
      memory: 123_456_789,
      sessions: [],
      chats: [
        {
          agentSessionId: '2015f7a9-8b8c-4018-8466-92a245c1f0fb',
          agent: 'claude',
          name: null,
          cpu: 1,
          memory: 123_456_789
        }
      ],
      history: [123_456_789]
    }))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reply reads only app and worktrees.
    const snapshot = {
      app: { cpu: 0, memory: 0, main: {}, renderer: {}, other: {}, history: [] },
      worktrees: [...terminal, ...chatOnly]
    } as unknown as MemorySnapshot

    const reply = toMemorySnapshotReply(snapshot)

    expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThan(4 * 1024 * 1024)
    expect(reply.worktrees).toHaveLength(3_500)
  })

  it('leaves out pane keys before a restored host would exceed the size limit', () => {
    const worktrees = Array.from({ length: 4_000 }, (_, i) => ({
      worktreeId: `w-${i}-${'x'.repeat(370)}`,
      worktreeName: 'main',
      repoId: 'repo',
      repoName: 'repo',
      cpu: 1,
      memory: 123_456_789,
      sessions: [
        {
          sessionId: `pty-${i}-${'x'.repeat(370)}`,
          paneKey: `tab-${i}-0123456789abcdef0123456789abcdef:leaf-0123456789abcdef0123456789`,
          pid: 1_000 + i,
          cpu: 1,
          memory: 123_456_789
        }
      ],
      history: [123_456_789]
    }))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reply reads only app and worktrees.
    const snapshot = {
      app: { cpu: 0, memory: 0, main: {}, renderer: {}, other: {}, history: [] },
      agentProcesses: { cpu: 0, memory: 0 },
      worktrees
    } as unknown as MemorySnapshot

    const reply = toMemorySnapshotReply(snapshot)

    expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThan(4 * 1024 * 1024)
    expect(reply.worktrees).toHaveLength(4_000)
    expect(reply.worktrees[0]?.sessions[0]?.paneKey).toBeNull()
    expect(reply.agentProcesses).toBeUndefined()
  })
})
