/**
 * Re-keying a workspace's session rows must not invent state the user never created.
 *
 * `tabsByWorktree` carries three states, not two: an absent row is "never initialized" and an
 * explicit empty row is the closed-last-terminal tombstone that `shouldAutoCreateInitialTerminal`
 * honours. Writing `[]` for a source that had no row turns the first into the second, and the
 * workspace then never gets its initial terminal.
 */
import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { canonicalizeTerminalSessionWorktreeId } from './workspace-session-worktree-id'

const SOURCE = 'repo-1::/old/path'
const TARGET = 'repo-1::/new/path'

function tab(id: string, worktreeId: string) {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

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
    // The other direction: an explicit empty row is user intent and must survive, so the guard has
    // to be about the source row's presence and not about the tabs being empty.
    const next = session({ tabsByWorktree: { [SOURCE]: [] } })

    canonicalizeTerminalSessionWorktreeId(next, SOURCE, TARGET)

    expect(Object.hasOwn(next.tabsByWorktree, TARGET)).toBe(true)
    expect(next.tabsByWorktree[TARGET]).toEqual([])
    expect(Object.hasOwn(next.tabsByWorktree, SOURCE)).toBe(false)
  })

  it('re-keys the tabs and their own worktree ids', () => {
    const next = session({ tabsByWorktree: { [SOURCE]: [tab('tab-1', SOURCE)] } })

    canonicalizeTerminalSessionWorktreeId(next, SOURCE, TARGET)

    expect(next.tabsByWorktree[TARGET]?.map((entry) => entry.worktreeId)).toEqual([TARGET])
  })
})
