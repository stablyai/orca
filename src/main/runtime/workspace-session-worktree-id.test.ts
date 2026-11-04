/** Absent tab rows mean never initialized; explicit empty rows are closed-last-tab tombstones. Re-keying must preserve that distinction. */
import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session/workspace-session-state-types'
import { canonicalizeTerminalSessionWorktreeId } from './workspace-session-worktree-id'

const SOURCE = 'repo-1::/old/path'
const TARGET = 'repo-1::/new/path'

function session(overrides: Partial<WorkspaceSessionState> = {}): WorkspaceSessionState {
  return { ...getDefaultWorkspaceSession(), ...overrides }
}

describe('canonicalizeTerminalSessionWorktreeId', () => {
  it('does not fabricate a tombstone for a workspace that had no tabs row', () => {
    const next = session({ tabsByWorktree: {} })

    canonicalizeTerminalSessionWorktreeId(next, SOURCE, TARGET)

    expect(Object.hasOwn(next.tabsByWorktree, TARGET)).toBe(false)
  })

  it('carries a real closed-last-terminal tombstone across the re-key', () => {
    // Explicit empty rows preserve the user's closed-last-terminal intent.
    const next = session({ tabsByWorktree: { [SOURCE]: [] } })

    canonicalizeTerminalSessionWorktreeId(next, SOURCE, TARGET)

    expect(Object.hasOwn(next.tabsByWorktree, TARGET)).toBe(true)
    expect(next.tabsByWorktree[TARGET]).toEqual([])
    expect(Object.hasOwn(next.tabsByWorktree, SOURCE)).toBe(false)
  })
})
