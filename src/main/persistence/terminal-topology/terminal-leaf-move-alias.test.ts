import { describe, expect, it, vi } from 'vitest'
import { getDefaultUIState } from '../../../shared/constants'
import type { LegacyPaneKeyAliasEntry } from '../../../shared/persisted-state-types'
import type { TerminalLeafMoveRequest } from '../../../shared/terminal-leaf-move'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { commitWindowPaneDetach } from './layout-command-commit'
import { moveLeaf, type TerminalTopologyCommitContext } from './terminal-topology-commit'

const WT = 'repo-1::/tmp/wt'
const SOURCE = 'tab-source'
const TARGET = 'tab-target'
const LEFT = '11111111-1111-4111-8111-111111111111'
const MOVED = '22222222-2222-4222-8222-222222222222'
const FROM = `${SOURCE}:${MOVED}`
const TO = `${TARGET}:${MOVED}`
const request: TerminalLeafMoveRequest = {
  worktreeId: WT,
  sourceTabId: SOURCE,
  targetTabId: TARGET,
  leafId: MOVED,
  ptyId: 'pty-agent'
}

function session(movedIsBound: boolean): WorkspaceSessionState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: WT,
    activeTabId: SOURCE,
    tabsByWorktree: {
      [WT]: [
        {
          id: SOURCE,
          ptyId: 'pty-left',
          worktreeId: WT,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      [SOURCE]: {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: LEFT },
          second: { type: 'leaf', leafId: MOVED }
        },
        activeLeafId: LEFT,
        expandedLeafId: null,
        ptyIdsByLeafId: movedIsBound
          ? { [LEFT]: 'pty-left', [MOVED]: 'pty-agent' }
          : { [LEFT]: 'pty-left' }
      }
    }
  }
}

function entry(legacyPaneKey: string, stablePaneKey: string): LegacyPaneKeyAliasEntry {
  return { ptyId: 'pty-agent', legacyPaneKey, stablePaneKey, updatedAt: 5 }
}

function contextWith(aliases: LegacyPaneKeyAliasEntry[], movedIsBound = true) {
  const markDirty = vi.fn()
  const state: TerminalTopologyCommitContext['state'] = {
    workspaceSession: session(movedIsBound),
    workspaceSessionsByHostId: {},
    ui: getDefaultUIState(),
    sshRemotePtyLeases: [],
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

describe('a pane move writes its physical-key alias in the same durable mutation', () => {
  it('persists source-key -> target-key before any hook-server save', () => {
    const { state, context, markDirty } = contextWith([])

    const committed = moveLeaf(request, context)()

    expect(committed.value).toEqual({ status: 'moved', ptyId: 'pty-agent' })
    expect(state.legacyPaneKeyAliasEntries).toEqual([
      { ptyId: 'pty-agent', legacyPaneKey: FROM, stablePaneKey: TO, updatedAt: expect.any(Number) }
    ])
    expect(markDirty).toHaveBeenCalledWith('legacyPaneKeyAliasEntries')
  })

  it('restores the previous aliases when the write rolls back', () => {
    const { state, context } = contextWith([])

    const committed = moveLeaf(request, context)()
    committed.rollback?.()

    expect(state.legacyPaneKeyAliasEntries).toEqual([])
  })

  it('moves a chained alias to the new owner instead of adding a second entry', () => {
    const earlier = `tab-earlier:${MOVED}`
    const { state, context } = contextWith([entry(earlier, FROM)])

    moveLeaf(request, context)()

    expect(state.legacyPaneKeyAliasEntries).toEqual([
      {
        ptyId: 'pty-agent',
        legacyPaneKey: earlier,
        stablePaneKey: TO,
        updatedAt: expect.any(Number)
      }
    ])
  })

  it('drops the alias rather than writing a self-alias when the pane returns to its first key', () => {
    const { state, context } = contextWith([entry(TO, FROM)])

    moveLeaf(request, context)()

    expect(state.legacyPaneKeyAliasEntries).toEqual([])
  })

  it('writes no alias for a pane that has no PTY', () => {
    const { state, context, markDirty } = contextWith([], false)

    moveLeaf({ ...request, ptyId: null }, context)()

    expect(state.legacyPaneKeyAliasEntries).toEqual([])
    expect(markDirty).not.toHaveBeenCalledWith('legacyPaneKeyAliasEntries')
  })
})

describe('a window drag-out through layout.apply writes the same alias in its own mutation', () => {
  const detach = {
    type: 'movePaneToNewTab' as const,
    workspace: WT,
    tabId: SOURCE,
    leafId: MOVED,
    windowDetach: { ptyId: 'pty-agent', tabId: TARGET }
  }

  it('persists source-key -> target-key with the bound PTY, and restores on rollback', () => {
    const { state, context, markDirty } = contextWith([])

    const committed = commitWindowPaneDetach(['local'], detach, context)

    expect(committed.value).toMatchObject({ ok: true })
    expect(state.legacyPaneKeyAliasEntries).toEqual([
      { ptyId: 'pty-agent', legacyPaneKey: FROM, stablePaneKey: TO, updatedAt: expect.any(Number) }
    ])
    expect(markDirty).toHaveBeenCalledWith('legacyPaneKeyAliasEntries')
    committed.rollback?.()
    expect(state.legacyPaneKeyAliasEntries).toEqual([])
  })

  it('writes no alias for a pane that has no PTY', () => {
    const { state, context } = contextWith([], false)

    commitWindowPaneDetach(
      ['local'],
      { ...detach, windowDetach: { ptyId: null, tabId: TARGET } },
      context
    )

    expect(state.legacyPaneKeyAliasEntries).toEqual([])
  })
})
