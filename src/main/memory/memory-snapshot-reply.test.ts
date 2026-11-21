import { describe, expect, it } from 'vitest'
import type { MemorySnapshot } from '../../shared/diagnostics/process-stats-types'
import { toMemorySnapshotReply } from './memory-snapshot-reply'

describe('the memory snapshot sent over RPC', () => {
  it('keeps every row but only its 20 most recent history points', () => {
    const history = Array.from({ length: 60 }, (_, i) => i + 1)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reply reads only app and worktree histories.
    const snapshot = {
      app: { cpu: 0, memory: 0, main: {}, renderer: {}, other: {}, history },
      worktrees: Array.from({ length: 4_000 }, (_, i) => ({ worktreeId: `w${i}`, history }))
    } as unknown as MemorySnapshot

    const reply = toMemorySnapshotReply(snapshot)

    expect(reply.app.history).toEqual([
      41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60
    ])
    expect(reply.worktrees).toHaveLength(4_000)
    expect(reply.worktrees.every((worktree) => worktree.history.length === 20)).toBe(true)
    expect(reply.worktrees[3_999]?.history.at(-1)).toBe(60)
  })
})
