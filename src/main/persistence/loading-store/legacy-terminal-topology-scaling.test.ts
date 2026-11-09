import { LegacyTerminalBindingReplay } from './legacy-terminal-binding-replay'
import type * as BindingReplay from './workspace-session-terminal-binding-replay'
import { createHash } from 'node:crypto'
import * as retirement from '../../pty/legacy-terminal-retirement'
import { fixture } from './profile-state-delayed-authority-fixture'
import { TerminalIdentityHandoff } from '../../pty/terminal-identity-handoff'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { initializeLegacyTerminalIdentityClaims } from './legacy-terminal-identity-claims'
import {
  admitPane,
  moveLeaf,
  withdrawPane,
  topologyCommitContext
} from '../terminal-topology/terminal-topology-commit'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))

const replayProbe = vi.hoisted(() => ({ enabled: false, copies: 0, entries: 0 }))
vi.mock('./workspace-session-terminal-binding-replay', async (importOriginal) => {
  const original = await importOriginal<typeof BindingReplay>()
  return {
    ...original,
    preserveMissingWorkspaceSessionTerminalBindings(
      ...args: Parameters<typeof original.preserveMissingWorkspaceSessionTerminalBindings>
    ) {
      if (!replayProbe.enabled) {
        return original.preserveMissingWorkspaceSessionTerminalBindings(...args)
      }
      const session = args[0]
      const originals = new WeakMap<object, Record<string, string>>()
      const tracked = (value: Record<string, string> | undefined) => {
        if (!value || originals.has(value)) {
          return value
        }
        const proxy = new Proxy(value, {
          ownKeys(target) {
            const keys = Reflect.ownKeys(target)
            replayProbe.copies += 1
            replayProbe.entries += keys.length
            return keys
          }
        })
        originals.set(proxy, value)
        return proxy
      }
      let stamps = tracked(session.terminalPtyIncarnationsByPaneKey)
      // Also wrap intermediate assignments: counting only the input misses repeated later spreads.
      Object.defineProperty(session, 'terminalPtyIncarnationsByPaneKey', {
        configurable: true,
        enumerable: true,
        get: () => stamps,
        set: (value) => {
          stamps = tracked(value)
        }
      })
      const rebase = LegacyTerminalBindingReplay.prototype.rebase
      const calls = vi
        .spyOn(LegacyTerminalBindingReplay.prototype, 'rebase')
        .mockImplementation(function (this: LegacyTerminalBindingReplay, ...input) {
          const row = rebase.apply(this, input)
          // Follow private candidate wrappers so every later materialization is counted too.
          this.session.terminalPtyIncarnationsByPaneKey = tracked(
            this.session.terminalPtyIncarnationsByPaneKey
          )
          return row
        })
      let result:
        | ReturnType<typeof original.preserveMissingWorkspaceSessionTerminalBindings>
        | undefined
      try {
        result = original.preserveMissingWorkspaceSessionTerminalBindings(...args)
        return result
      } finally {
        calls.mockRestore()
        for (const state of new Set([session, result])) {
          if (!state) {
            continue
          }
          const value = state.terminalPtyIncarnationsByPaneKey
          Object.defineProperty(state, 'terminalPtyIncarnationsByPaneKey', {
            configurable: true,
            enumerable: true,
            writable: true,
            value: value ? (originals.get(value) ?? value) : undefined
          })
        }
      }
    }
  }
})

describe('incremental terminal membership identity work', () => {
  it.each([300, 3000])(
    'observes only admitted and removed membership in a %i-tab corpus',
    (count) => {
      const runtime = {
        state: getDefaultPersistedState('/tmp/identity-topology-scaling'),
        dirtyProfileStateDomains: new Set<string>()
      }
      runtime.state.repos = [
        { id: 'repo', path: '/original', displayName: 'Repo', badgeColor: '', addedAt: 1 }
      ]
      const claims = initializeLegacyTerminalIdentityClaims(runtime)
      const rows = vi.spyOn(claims, 'observeRow')
      const layouts = vi.spyOn(claims, 'observeLayout')
      const context = topologyCommitContext({
        runtime,
        sessions: {
          getWorkspaceSessionHostIds: () => [LOCAL_EXECUTION_HOST_ID],
          getWorkspaceSession: () => runtime.state.workspaceSession
        }
      })
      const existing = Array.from({ length: count - 1 }, (_, index) => ({
        id: `tab-${index}`,
        worktreeId: 'repo::/original',
        ptyId: String(index + 10),
        title: 'Terminal',
        customTitle: null,
        color: null,
        sortOrder: index,
        createdAt: 1
      }))
      runtime.state.workspaceSession.tabsByWorktree['repo::/original'] = existing
      const index = count - 1
      const mutation = admitPane(
        LOCAL_EXECUTION_HOST_ID,
        {
          type: 'createTerminalTab',
          workspace: 'repo::/original',
          tabId: `tab-${index}`,
          leafId: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`
        },
        context
      )()
      expect(mutation.value).toBe('admitted')
      // Each command creates exactly one membership; unrelated panes have no new identity facts.
      expect(rows).not.toHaveBeenCalled()
      expect(layouts).toHaveBeenCalledTimes(1)
      const last = `11111111-1111-4111-8111-${String(count - 1).padStart(12, '0')}`
      const withdrawal = withdrawPane(
        LOCAL_EXECUTION_HOST_ID,
        {
          type: 'closePane',
          workspace: 'repo::/original',
          tabId: `tab-${count - 1}`,
          leafId: last
        },
        context
      )()
      expect(withdrawal.value).toBeNull()
      expect(rows).not.toHaveBeenCalled()
      expect(layouts.mock.calls.length).toBeLessThanOrEqual(2)
      expect(runtime.state.workspaceSession.tabsByWorktree['repo::/original']).toHaveLength(
        count - 1
      )
    },
    120_000
  )
})

it.each([300, 3000])('moves only the affected identity memberships in a %i-tab corpus', (count) => {
  const state = getDefaultPersistedState('/tmp/identity-move-scaling')
  state.repos = [{ id: 'repo', path: '/original', displayName: 'Repo', badgeColor: '', addedAt: 1 }]
  const workspace = 'repo::/original'
  const leafId = '11111111-1111-4111-8111-111111111111'
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `tab-${index}`,
    worktreeId: workspace,
    ptyId: String(index + 9),
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: index,
    createdAt: 1
  }))
  state.workspaceSession.tabsByWorktree = { [workspace]: rows }
  state.workspaceSession.terminalLayoutsByTabId = Object.fromEntries(
    rows.map((row, index) => {
      const leaf =
        index === 0 ? leafId : `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`
      return [
        row.id,
        {
          root: { type: 'leaf', leafId: leaf },
          activeLeafId: leaf,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leaf]: row.ptyId }
        }
      ]
    })
  )
  const runtime = { state, dirtyProfileStateDomains: new Set<string>() }
  const claims = initializeLegacyTerminalIdentityClaims(runtime)
  const visits = vi.spyOn(TerminalIdentityHandoff.prototype, 'observe')
  const context = topologyCommitContext({
    runtime,
    sessions: {
      getWorkspaceSessionHostIds: () => [LOCAL_EXECUTION_HOST_ID],
      getWorkspaceSession: () => runtime.state.workspaceSession
    }
  })
  try {
    const mutation = moveLeaf(
      { worktreeId: workspace, sourceTabId: 'tab-0', targetTabId: 'moved', leafId, ptyId: '9' },
      context
    )()
    // A move has one source and one destination, each with a before/after identity membership.
    expect(mutation.value).toMatchObject({ status: 'moved' })
    expect(visits.mock.calls.map((call) => [call[0], call[2]])).toEqual([
      ['before', 'tab-0'],
      ['after', 'tab-0'],
      ['before', 'moved'],
      ['after', 'moved']
    ])
    expect(claims.unique(workspace, `moved:${leafId}`, '9')).toBe(true)
    mutation.rollback?.()
    expect(claims.unique(workspace, `tab-0:${leafId}`, '9')).toBe(true)
  } finally {
    visits.mockRestore()
  }
})

it.each([300, 3000])(
  'does zero identity work for navigation and scopes unified removal in a %i-tab Store',
  async (count) => {
    const { store } = await fixture()
    const workspace = 'repo-local::/fixture/local'
    const rows = Array.from({ length: count }, (_, index) => ({
      id: `tab-${index}`,
      worktreeId: workspace,
      ptyId: String(index + 9),
      title: 'Terminal',
      customTitle: null,
      color: null,
      sortOrder: index,
      createdAt: 1,
      isPinned: index === 1
    }))
    const layouts = Object.fromEntries(
      rows.map((row, index) => {
        const leaf = `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`
        return [
          row.id,
          {
            root: { type: 'leaf' as const, leafId: leaf },
            activeLeafId: leaf,
            expandedLeafId: null,
            ptyIdsByLeafId: { [leaf]: row.ptyId }
          }
        ]
      })
    )
    const unified = rows.map((row) => ({
      id: `strip-${row.id}`,
      entityId: row.id,
      groupId: 'group',
      worktreeId: workspace,
      contentType: 'terminal' as const,
      label: 'Terminal',
      customLabel: null,
      color: null,
      sortOrder: row.sortOrder,
      createdAt: 1
    }))
    store.setWorkspaceSession({
      ...store.getWorkspaceSession(),
      tabsByWorktree: { [workspace]: rows },
      terminalLayoutsByTabId: layouts,
      unifiedTabs: { [workspace]: unified }
    })
    const claims = store.legacyTerminalIdentityAuthority
    const visits = vi.spyOn(TerminalIdentityHandoff.prototype, 'observe')
    const rowVisits = vi.spyOn(claims, 'observeRow')
    const layoutVisits = vi.spyOn(claims, 'observeLayout')
    const catalogVisits = vi.spyOn(claims, 'refreshCatalog')
    const retirements = vi.spyOn(retirement, 'retireRemovedScopedTerminalRow')
    try {
      store.patchWorkspaceSession({ activeTabId: 'tab-1' })
      store.updateOnboarding({})
      await store.flushPendingOrThrowAsync()
      store.patchWorkspaceSession({
        activeTabId: 'tab-2',
        unifiedTabs: { [workspace]: unified.map((tab) => ({ ...tab })) }
      })
      expect(store.getWorkspaceSession().activeTabId).toBe('tab-2')
      expect(visits).not.toHaveBeenCalled()
      expect(rowVisits).not.toHaveBeenCalled()
      expect(layoutVisits).not.toHaveBeenCalled()
      expect(catalogVisits).not.toHaveBeenCalled()
      store.patchWorkspaceSession({ unifiedTabs: { [workspace]: unified.slice(1) } })
      // Unified-only removal has no new/moved identity to inspect; retire only the removed entity.
      expect(visits).not.toHaveBeenCalled()
      expect(retirements).toHaveBeenCalledTimes(1)
      expect(retirements.mock.calls[0].slice(1, 3)).toEqual([workspace, { id: 'tab-0' }])
      expect(rowVisits).not.toHaveBeenCalled()
      expect(layoutVisits.mock.calls.length).toBeLessThanOrEqual(1)
      retirements.mockClear()
      visits.mockClear()
      expect(
        await store.applyLayoutCommand({
          type: 'renameTab',
          workspace,
          tabId: 'strip-tab-1',
          kind: 'custom',
          title: 'Pinned terminal'
        })
      ).toMatchObject({ ok: true })
      expect(retirements).not.toHaveBeenCalled()
      expect(visits).not.toHaveBeenCalled()
      expect(
        await store.applyLayoutCommand({
          type: 'closeTabs',
          workspace,
          tabIds: ['strip-tab-1'],
          refusePinned: true
        })
      ).toMatchObject({
        ok: true,
        result: { closed: [], refused: [{ tabId: 'strip-tab-1', code: 'tab_pinned' }] }
      })
      expect(retirements).not.toHaveBeenCalled()
      expect(visits).not.toHaveBeenCalled()
      expect(
        await store.applyLayoutCommand({
          type: 'closeTabs',
          workspace,
          tabIds: ['strip-tab-2'],
          force: true
        })
      ).toMatchObject({ ok: true })
      // The accepted strip close adds exactly one terminal entity, independent of corpus size.
      expect(retirements.mock.calls.map((call) => [call[1], call[2]])).toEqual([
        [workspace, { id: 'tab-2' }]
      ])
      expect(visits.mock.calls.map((call) => [call[0], call[2]])).toEqual([
        ['before', 'tab-2'],
        ['after', 'tab-2']
      ])
    } finally {
      visits.mockRestore()
      rowVisits.mockRestore()
      layoutVisits.mockRestore()
      catalogVisits.mockRestore()
      retirements.mockRestore()
    }
  }
)

it.each([300, 3000])(
  'rebases a delayed %i-pane full Store snapshot with one stamp materialization',
  async (count) => {
    const { store } = await fixture()
    const workspace = 'repo-local::/fixture/local'
    const rows = Array.from({ length: count }, (_, index) => ({
      id: `rebase-${index}`,
      worktreeId: workspace,
      ptyId: String(index + 9),
      title: 'Terminal',
      customTitle: null,
      color: null,
      sortOrder: index,
      createdAt: 1
    }))
    const leaves = rows.map(
      (_, index) => `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`
    )
    const canonicalIds = rows.map(
      (row, index) =>
        `${workspace}@@${createHash('sha256')
          .update(JSON.stringify(['orca-terminal-leaf-v1', workspace, leaves[index], row.ptyId]))
          .digest('hex')
          .slice(0, 8)}`
    )
    const stamps = Object.fromEntries(
      rows.map((row, index) => [`${row.id}:${leaves[index]}`, `owner-${index}`])
    )
    const layouts = Object.fromEntries(
      rows.map((row, index) => [
        row.id,
        {
          root: { type: 'leaf' as const, leafId: leaves[index] },
          activeLeafId: leaves[index],
          expandedLeafId: null,
          ptyIdsByLeafId: { [leaves[index]]: canonicalIds[index] }
        }
      ])
    )
    store.setWorkspaceSession({
      ...store.getWorkspaceSession(),
      tabsByWorktree: {
        [workspace]: rows.map((row, index) => ({ ...row, ptyId: canonicalIds[index] }))
      },
      terminalLayoutsByTabId: layouts,
      terminalPtyIncarnationsByPaneKey: { ...stamps, unrelated: 'retained' },
      unifiedTabs: undefined
    })
    const prior = store.getWorkspaceSession()
    const priorBefore = structuredClone(prior)
    const incoming = {
      ...prior,
      tabsByWorktree: { [workspace]: rows },
      terminalLayoutsByTabId: Object.fromEntries(
        rows.map((row, index) => [
          row.id,
          {
            ...layouts[row.id],
            ptyIdsByLeafId: { [leaves[index]]: row.ptyId }
          }
        ])
      ),
      terminalPtyIncarnationsByPaneKey: {
        ...Object.fromEntries(Object.keys(stamps).map((pane) => [pane, 'stale-owner'])),
        unrelated: 'retained'
      }
    }
    const incomingBefore = structuredClone(incoming)
    replayProbe.copies = replayProbe.entries = 0
    replayProbe.enabled = true
    try {
      store.setWorkspaceSession(incoming)
    } finally {
      replayProbe.enabled = false
    }
    const accepted = store.getWorkspaceSession()
    expect(accepted.tabsByWorktree[workspace].map((row) => row.ptyId)).toEqual(canonicalIds)
    expect(
      rows.map(
        (row, index) => accepted.terminalLayoutsByTabId[row.id].ptyIdsByLeafId?.[leaves[index]]
      )
    ).toEqual(canonicalIds)
    expect(accepted.terminalPtyIncarnationsByPaneKey).toEqual({ ...stamps, unrelated: 'retained' })
    expect(incoming).toEqual(incomingBefore)
    expect(prior).toEqual(priorBefore)
    // One required P-entry copy plus K keyed edits, across the entire accepted full snapshot.
    expect(replayProbe.copies).toBeLessThanOrEqual(1)
    expect(replayProbe.entries).toBeLessThanOrEqual(count + 1)

    replayProbe.copies = replayProbe.entries = 0
    replayProbe.enabled = true
    try {
      store.setWorkspaceSession({ ...accepted })
    } finally {
      replayProbe.enabled = false
    }
    expect(replayProbe.copies).toBe(0)
    expect(replayProbe.entries).toBe(0)
    expect(store.getWorkspaceSession().terminalPtyIncarnationsByPaneKey).toBe(
      accepted.terminalPtyIncarnationsByPaneKey
    )
  }
)
