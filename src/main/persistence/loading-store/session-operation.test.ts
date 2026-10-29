import { enumerateSessionOperation } from './session-full-enumeration.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { SESSION_MAP_FIELDS } from '../../../shared/session-change-set'
import { SessionUnitIndex } from '../../../shared/session-unit-index'
import { SessionUnitReader } from '../../../shared/session-unit-reader'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { runSessionOperation, type SessionOperation } from './session-operation'
import { publishSessionChanges, sessionPublication } from './session-publication'

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      freeze(child)
    }
    Object.freeze(value)
  }
  return value
}
function tab(id: string, owner: string): TerminalTab {
  return {
    id,
    worktreeId: owner,
    ptyId: null,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

/** Shared oracle: identical operation inputs, complete roots, independent index rebuilds. */
function compareOperation(
  state: { workspaceSession: WorkspaceSessionState },
  operation: SessionOperation
): void {
  const prior = freeze(state.workspaceSession)
  const materialized = structuredClone(prior)
  const full = enumerateSessionOperation(prior, operation)
  runSessionOperation(state, 'local', operation)
  expect(state.workspaceSession).toStrictEqual(full)
  expect(state.workspaceSession).toEqual(
    expect.objectContaining({ tabsByWorktree: full.tabsByWorktree })
  )
  expect(prior).toStrictEqual(materialized)
  const actual = sessionPublication(state).partition('local').index
  const rebuilt = new SessionUnitIndex(full)
  for (const field of SESSION_MAP_FIELDS) {
    expect([...actual.keys(field)]).toEqual([...rebuilt.keys(field)])
    for (const key of rebuilt.keys(field)) {
      for (const kind of [
        'owner',
        'tab',
        'pane',
        'leaf',
        'pty',
        'file',
        'browser',
        'page',
        'repo',
        'scrollback'
      ] as const) {
        expect(actual.dependencyIds(field, key, kind)).toEqual(
          rebuilt.dependencyIds(field, key, kind)
        )
        for (const id of rebuilt.dependencyIds(field, key, kind)) {
          expect(actual.references(kind, id)).toEqual(rebuilt.references(kind, id))
        }
      }
    }
  }
}

describe('operation-rooted session reduction', () => {
  it('retains an empty removal target and its repo revision without indexed owner rows', () => {
    const state = {
      workspaceSession: {
        ...getDefaultWorkspaceSession(),
        terminalTopologyRevisionByRepoId: { repo: 7 }
      }
    }
    compareOperation(state, {
      type: 'removeOwners',
      owners: ['repo::/empty'],
      advanceRevision: true
    })
    expect(state.workspaceSession.terminalTopologyRevisionByRepoId.repo).toBe(8)
  })

  it('uses the complete repo revision for a first PTY surface and preserves unrelated units', () => {
    vi.spyOn(Date, 'now').mockReturnValue(17)
    try {
      const untouched = [tab('other-tab', 'other::/tree')]
      const state = {
        workspaceSession: {
          ...getDefaultWorkspaceSession(),
          tabsByWorktree: { 'other::/tree': untouched },
          terminalTopologyRevisionByRepoId: { repo: 1 }
        }
      }
      const leafId = '11111111-1111-4111-8111-111111111111'
      compareOperation(state, {
        type: 'bindPty',
        owner: 'repo::/new',
        paneKey: `new-tab:${leafId}`,
        binding: {
          worktreeId: 'repo::/new',
          tabId: 'new-tab',
          leafId,
          ptyId: 'pty-new',
          mayCreate: true
        }
      })
      expect(state.workspaceSession.terminalTopologyRevisionByRepoId.repo).toBe(2)
      expect(state.workspaceSession.tabsByWorktree['other::/tree']).toBe(untouched)
      expect(sessionPublication(state).partition('local').generation).toBe(1)
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('moves carried references and raw/workspace aliases, then removes both without mutating priors', () => {
    const source = 'repo::/old',
      target = 'repo::/new'
    const state: { workspaceSession: WorkspaceSessionState } = {
      workspaceSession: {
        ...getDefaultWorkspaceSession(),
        tabsByWorktree: { [source]: [tab('tab', source)] },
        activeTabIdByWorktree: { [`worktree:${source}`]: 'tab' },
        lastVisitedAtByWorktreeId: { [`local|${source}`]: 4, [`local|${target}`]: 9 }
      }
    }
    compareOperation(state, { type: 'moveOwner', oldId: source, newId: target })
    expect(state.workspaceSession.lastVisitedAtByWorktreeId?.[`local|${target}`]).toBe(9)
    compareOperation(state, { type: 'moveOwner', oldId: source, newId: target })
    compareOperation(state, {
      type: 'removeOwners',
      owners: [target, `worktree:${target}`],
      advanceRevision: false
    })
    expect(state.workspaceSession.tabsByWorktree).toEqual({})
  })

  it('publishes complete policy-field removals and order with a matching rebuilt index', () => {
    const state: { workspaceSession: WorkspaceSessionState } = {
      workspaceSession: {
        ...getDefaultWorkspaceSession(),
        closedTerminalTabTombstonesByTabId: {
          a: { worktreeId: 'repo::/a', closedAt: 1, reason: 'user' },
          b: { worktreeId: 'repo::/b', closedAt: 2, reason: 'user' }
        }
      }
    }
    const prior = freeze(state.workspaceSession)
    const reader = new SessionUnitReader(prior, sessionPublication(state).partition('local').index)
    reader.replace('closedTerminalTabTombstonesByTabId', {
      present: true,
      value: {
        b: reader.policy('closedTerminalTabTombstonesByTabId')!.b,
        a: reader.policy('closedTerminalTabTombstonesByTabId')!.a
      }
    })
    reader.replace('activeWorkspaceKey', { present: false, value: undefined })
    publishSessionChanges(state, 'local', reader.prepare({ kind: 'authoritative' }))
    expect(Object.keys(state.workspaceSession.closedTerminalTabTombstonesByTabId!)).toEqual([
      'b',
      'a'
    ])
    expect([
      ...sessionPublication(state)
        .partition('local')
        .index.keys('closedTerminalTabTombstonesByTabId')
    ]).toEqual(['b', 'a'])
    expect(Object.hasOwn(state.workspaceSession, 'activeWorkspaceKey')).toBe(false)
    expect(Object.keys(prior.closedTerminalTabTombstonesByTabId!)).toEqual(['a', 'b'])
  })
})
