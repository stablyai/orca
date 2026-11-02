import { describe, expect, it } from 'vitest'
import type { RuntimeWorktreePsSummary } from '../../shared/runtime-types'
import { applyRuntimeWorktreePsUnverifiableTerminals } from './runtime-worktree-ps-unverifiable-terminals'

describe('unverifiable terminal attribution', () => {
  it('follows the host PTY record, not a stale pane, as the live pass does', () => {
    const summaries = new Map<string, Partial<RuntimeWorktreePsSummary>>([
      ['wt-old', {}],
      ['wt-new', {}]
    ])
    applyRuntimeWorktreePsUnverifiableTerminals({
      countedPtyIds: new Set(),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pass reads only ptyId and worktreeId.
      leaves: [{ ptyId: 'pty-1', worktreeId: 'wt-old' } as never],
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pass reads only ptyId and worktreeId.
      ptysById: new Map([['pty-1', { ptyId: 'pty-1', worktreeId: 'wt-new' } as never]]),
      getLivenessVerdict: () => ({ status: 'unverifiable', reason: 'lost contact' }),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the counters this pass writes are read back.
      getSummary: (id) => (summaries.get(id) as RuntimeWorktreePsSummary | undefined) ?? null
    })
    expect(summaries.get('wt-new')?.unverifiableTerminalCount).toBe(1)
    expect(summaries.get('wt-old')?.unverifiableTerminalCount).toBeUndefined()
  })
})
