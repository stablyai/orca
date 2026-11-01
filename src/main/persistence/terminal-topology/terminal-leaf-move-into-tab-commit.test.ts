import { describe, expect, it, vi } from 'vitest'
import { getDefaultUIState } from '../../../shared/constants'
import type { LegacyPaneKeyAliasEntry } from '../../../shared/persisted-state-types'
import type { TerminalLeafIntoTabRequest } from '../../../shared/terminal-leaf-move'
import {
  A,
  FROM,
  intoRequest,
  intoTabSession,
  SOURCE,
  TARGET,
  TO,
  WT
} from './terminal-leaf-move-into-tab-fixture'
import { moveLeafIntoTab } from './terminal-topology-commit-into-tab'
import type { TerminalTopologyCommitContext } from './terminal-topology-commit'

const frozen = vi.hoisted(() => ({ worktrees: new Set<string>() }))
vi.mock('../moving-wsl-projects/wsl-move-scope-guard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isWslMoveWorkspaceSessionFrozen: (worktreeId: string) => frozen.worktrees.has(worktreeId)
}))

function contextWith(aliases: LegacyPaneKeyAliasEntry[] = []) {
  const markDirty = vi.fn()
  const state: TerminalTopologyCommitContext['state'] = {
    workspaceSession: intoTabSession(),
    workspaceSessionsByHostId: {},
    ui: {
      ...getDefaultUIState(),
      acknowledgedAgentsByPaneKey: { [FROM]: 10, other: 1 },
      activityClearedAtByPaneKey: { [FROM]: 11 },
      manuallyUnreadTurnsByPaneKey: { [FROM]: 12 }
    },
    sshRemotePtyLeases: [
      {
        targetId: 'ssh-1',
        ptyId: 'pty-a',
        worktreeId: WT,
        tabId: SOURCE,
        leafId: A,
        state: 'attached',
        createdAt: 1,
        updatedAt: 1
      },
      {
        targetId: 'ssh-1',
        ptyId: 'pty-x',
        worktreeId: WT,
        tabId: SOURCE,
        leafId: 'other',
        state: 'attached',
        createdAt: 1,
        updatedAt: 1
      }
    ],
    legacyPaneKeyAliasEntries: aliases
  }
  const context: TerminalTopologyCommitContext = {
    state,
    hostIds: () => ['local'],
    getSession: () => state.workspaceSession,
    markDirty
  }
  return { state, context, markDirty }
}

function commit(request: TerminalLeafIntoTabRequest, context: TerminalTopologyCommitContext) {
  return moveLeafIntoTab(request, context)()
}

describe('committing a join into an existing tab', () => {
  it('writes the session, the pane-keyed profile records and the alias in one mutation', () => {
    const { state, context, markDirty } = contextWith()

    const committed = commit(intoRequest, context)

    expect(committed.value).toEqual({ status: 'moved', ptyId: 'pty-a', sourceTabClosed: true })
    expect(state.workspaceSession.tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual([TARGET])
    expect(state.workspaceSession.terminalLayoutsByTabId[TARGET]?.ptyIdsByLeafId?.[A]).toBe('pty-a')
    expect(state.ui).toMatchObject({
      acknowledgedAgentsByPaneKey: { [TO]: 10, other: 1 },
      activityClearedAtByPaneKey: { [TO]: 11 },
      manuallyUnreadTurnsByPaneKey: { [TO]: 12 }
    })
    expect(state.sshRemotePtyLeases?.map((lease) => [lease.ptyId, lease.tabId])).toEqual([
      ['pty-a', TARGET],
      ['pty-x', SOURCE]
    ])
    expect(state.legacyPaneKeyAliasEntries).toEqual([
      { ptyId: 'pty-a', legacyPaneKey: FROM, stablePaneKey: TO, updatedAt: expect.any(Number) }
    ])
    for (const domain of [
      'workspaceSession',
      'ui',
      'sshRemotePtyLeases',
      'legacyPaneKeyAliasEntries'
    ]) {
      expect(markDirty).toHaveBeenCalledWith(domain)
    }
  })

  it('moves a chained alias to the new owner instead of adding a second entry', () => {
    const earlier = `tab-earlier:${A}`
    const { state, context } = contextWith([
      { ptyId: 'pty-a', legacyPaneKey: earlier, stablePaneKey: FROM, updatedAt: 5 }
    ])

    commit(intoRequest, context)

    expect(state.legacyPaneKeyAliasEntries).toEqual([
      { ptyId: 'pty-a', legacyPaneKey: earlier, stablePaneKey: TO, updatedAt: expect.any(Number) }
    ])
  })

  it('restores the session, profile records and aliases together when the write rolls back', () => {
    const { state, context } = contextWith()
    const before = {
      session: state.workspaceSession,
      ui: state.ui,
      leases: state.sshRemotePtyLeases,
      aliases: state.legacyPaneKeyAliasEntries
    }

    commit(intoRequest, context).rollback?.()

    expect(state.workspaceSession).toBe(before.session)
    expect(state.ui).toBe(before.ui)
    expect(state.sshRemotePtyLeases).toBe(before.leases)
    expect(state.legacyPaneKeyAliasEntries).toBe(before.aliases)
  })

  it.each([
    ['a refusal', { targetLeafId: '55555555-5555-4555-8555-555555555555' }, 'refused'],
    ['a leaf main never held', { leafId: '66666666-6666-4666-8666-666666666666' }, 'not_held']
  ])('persists nothing for %s', (_name, patch, status) => {
    const { state, context, markDirty } = contextWith()
    const before = structuredClone(state)

    const committed = commit({ ...intoRequest, ...patch }, context)

    expect(committed.value.status).toBe(status)
    expect(committed.persist).toBe(false)
    expect(markDirty).not.toHaveBeenCalled()
    expect(state).toEqual(before)
  })
})

describe('a join in a workspace paused by a WSL move', () => {
  it('is refused up front: nothing is written, so the window never closes the source tab', () => {
    frozen.worktrees.add(WT)
    try {
      const { state, context, markDirty } = contextWith()
      const before = state.workspaceSession

      const committed = commit(intoRequest, context)

      expect(committed.value).toEqual({ status: 'refused', reason: 'workspace_frozen' })
      expect(committed.persist).toBe(false)
      expect(state.workspaceSession).toBe(before)
      expect(state.legacyPaneKeyAliasEntries).toEqual([])
      expect(markDirty).not.toHaveBeenCalled()
    } finally {
      frozen.worktrees.clear()
    }
  })

  it('joins normally once the workspace is not paused', () => {
    const { context } = contextWith()

    expect(commit(intoRequest, context).value).toMatchObject({ status: 'moved' })
  })
})
