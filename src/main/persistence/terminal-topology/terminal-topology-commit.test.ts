import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { TerminalSurfaceCloseTarget } from '../../../shared/terminal-surface-close-target'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { _resetTracerForTests, setActiveSink } from '../../observability/tracer'
import type { TerminalSurfaceCloseCommit } from '../../runtime/terminal-surface-close'
import { closeLeafOrTab } from './terminal-topology-commit'

// An ssh: partition, so a leaked host id or worktree path would show in the span.
const HOST_ID: ExecutionHostId = 'ssh:target-1'
const WORKTREE_ID = 'ssh-repo::/srv/app'
const LEAF_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_2 = '22222222-2222-4222-8222-222222222222'
const SPLIT_TAB = 'tab-split'
const PINNED_TAB = 'tab-pinned'
const CLOSED_TAB = 'tab-closed-earlier'
const NOW = 1_700_000_000_000

function tab(id: string, ptyId: string, isPinned = false) {
  return {
    id,
    ptyId,
    worktreeId: WORKTREE_ID,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...(isPinned ? { isPinned } : {})
  }
}

function session(): WorkspaceSessionState {
  return {
    activeRepoId: 'ssh-repo',
    activeWorktreeId: WORKTREE_ID,
    activeTabId: SPLIT_TAB,
    tabsByWorktree: { [WORKTREE_ID]: [tab(SPLIT_TAB, 'pty-1'), tab(PINNED_TAB, 'pty-3', true)] },
    terminalLayoutsByTabId: {
      [SPLIT_TAB]: {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: LEAF_1 },
          second: { type: 'leaf', leafId: LEAF_2 }
        },
        activeLeafId: LEAF_1,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_1]: 'pty-1', [LEAF_2]: 'pty-2' }
      }
    },
    closedTerminalTabTombstonesByTabId: {
      [CLOSED_TAB]: { closedAt: NOW - 1000, worktreeId: WORKTREE_ID, reason: 'user' }
    },
    terminalTopologyRevisionByRepoId: { 'ssh-repo': 3 }
  }
}

function commitFor(
  target: TerminalSurfaceCloseTarget,
  overrides: Partial<TerminalSurfaceCloseCommit> = {}
): TerminalSurfaceCloseCommit {
  let current = session()
  return {
    worktreeId: WORKTREE_ID,
    target,
    options: {},
    requestedSession: current,
    ownerMatches: () => true,
    hostId: () => HOST_ID,
    getSession: () => current,
    setSession: (next) => {
      current = next
    },
    onClosed: () => {},
    ...overrides
  }
}

describe('persistence.terminal-topology span', () => {
  let records: { name: string; attributes: Record<string, unknown>; exit: unknown }[]

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    records = []
    setActiveSink({
      push: (record) => {
        records.push(JSON.parse(JSON.stringify(record)))
      },
      flush: () => {},
      close: () => {}
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    _resetTracerForTests()
  })

  function attributesAfter(commit: TerminalSurfaceCloseCommit): Record<string, unknown> {
    closeLeafOrTab(commit)()
    expect(records).toHaveLength(1)
    expect(records[0].name).toBe('persistence.terminal-topology')
    return records[0].attributes
  }

  it('records a committed pane close without ids', () => {
    expect(attributesAfter(commitFor({ kind: 'pane', tabId: SPLIT_TAB, leafId: LEAF_2 }))).toEqual({
      kind: 'persistence',
      'topology.kind': 'close_leaf',
      'topology.outcome': 'committed'
    })
    expect(JSON.stringify(records[0])).not.toMatch(/pty-|tab-split|ssh-repo|srv|target-1/)
  })

  it('records a committed tab close', () => {
    expect(attributesAfter(commitFor({ kind: 'tab', tabId: SPLIT_TAB }))).toMatchObject({
      'topology.kind': 'close_tab',
      'topology.outcome': 'committed'
    })
  })

  it('records a refusal with its reason code', () => {
    expect(attributesAfter(commitFor({ kind: 'tab', tabId: PINNED_TAB }))).toMatchObject({
      'topology.kind': 'close_tab',
      'topology.outcome': 'refused',
      'topology.refusal': 'terminal_tab_pinned'
    })
  })

  it('records a close that changes nothing as a noop', () => {
    const echo = commitFor({ kind: 'tab', tabId: CLOSED_TAB }, { options: { allowMissing: true } })
    expect(attributesAfter(echo)).toMatchObject({ 'topology.outcome': 'noop' })
  })

  it('records a thrown commit as a failed span and rethrows', () => {
    const mutation = closeLeafOrTab(
      commitFor(
        { kind: 'tab', tabId: SPLIT_TAB },
        {
          getSession: () => {
            throw new Error('read failed')
          }
        }
      )
    )
    expect(mutation).toThrow('read failed')
    expect(records).toHaveLength(1)
    expect(records[0].attributes).toMatchObject({ 'topology.outcome': 'threw' })
    expect(records[0].exit).toMatchObject({ _tag: 'Failure' })
  })
})
