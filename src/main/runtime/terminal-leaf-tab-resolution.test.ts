import { describe, expect, it } from 'vitest'

import type { TerminalLayoutSnapshot } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { findTerminalTabIdForLeaf } from '../persistence/terminal-topology/terminal-topology-membership'

function layout(...leafIds: string[]): TerminalLayoutSnapshot {
  let root = { type: 'leaf' as const, leafId: leafIds[0] }
  for (const leafId of leafIds.slice(1)) {
    root = {
      type: 'split',
      direction: 'row',
      first: root,
      second: { type: 'leaf' as const, leafId }
    } as never
  }
  return { root, activeLeafId: leafIds[0], ptyIdsByLeafId: {} } as TerminalLayoutSnapshot
}

function session(layouts: Record<string, TerminalLayoutSnapshot>): WorkspaceSessionState {
  return { terminalLayoutsByTabId: layouts } as WorkspaceSessionState
}

describe('findTerminalTabIdForLeaf', () => {
  it('resolves every leaf of a split tree to its tab', () => {
    const state = session({
      'tab-a': layout('leaf-1', 'leaf-2', 'leaf-3'),
      'tab-b': layout('leaf-4')
    })
    expect(findTerminalTabIdForLeaf(state, 'leaf-2')).toBe('tab-a')
    expect(findTerminalTabIdForLeaf(state, 'leaf-3')).toBe('tab-a')
    expect(findTerminalTabIdForLeaf(state, 'leaf-4')).toBe('tab-b')
  })

  it('keeps the first tab in record order when two layouts claim one leaf', () => {
    const layouts = { 'tab-a': layout('shared'), 'tab-b': layout('shared') }
    expect(findTerminalTabIdForLeaf(session(layouts), 'shared')).toBe('tab-a')
  })

  it('answers misses, empty sessions and empty layouts with undefined', () => {
    expect(findTerminalTabIdForLeaf(undefined, 'leaf-1')).toBeUndefined()
    expect(findTerminalTabIdForLeaf(session({}), 'leaf-1')).toBeUndefined()
    expect(findTerminalTabIdForLeaf(session({ 'tab-a': layout('leaf-1') }), 'nope')).toBeUndefined()
  })

  // persistPtyBinding can mutate layouts without changing root identity; cross-read caches would need to validate such changes.
  it('reflects a subtree replaced in place after an earlier read', () => {
    const tracked = layout('leaf-1', 'leaf-2')
    const state = session({ 'tab-a': tracked })
    expect(findTerminalTabIdForLeaf(state, 'leaf-2')).toBe('tab-a')
    expect(findTerminalTabIdForLeaf(state, 'leaf-9')).toBeUndefined()

    const root = tracked.root as { second: unknown }
    root.second = { type: 'leaf', leafId: 'leaf-9' }

    expect(findTerminalTabIdForLeaf(state, 'leaf-9')).toBe('tab-a')
    expect(findTerminalTabIdForLeaf(state, 'leaf-2')).toBeUndefined()
  })
})
