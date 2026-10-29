import { describe, expect, it, vi } from 'vitest'
import { SessionUnitReader } from '../../../shared/session-unit-reader'
import { SessionUnitIndex } from '../../../shared/session-unit-index'
import { SESSION_MAP_FIELDS } from '../../../shared/session-change-set'
import {
  buildWorktreeIdByFileId,
  buildWorktreeIdByTabId
} from '../../../shared/workspace-session-host-records'
import { workspaceSessionEntryOwner } from '../../../shared/workspace-session-stranded-partition-adoption'
import {
  addWorkspace,
  emptySession,
  GIT_KEY,
  FOLDER_KEY,
  leaf
} from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { makeTerminalTab } from '../persistence-session-fixtures'
import { publishSessionChanges, sessionPublication } from './session-publication'
import { nativeAffectedOwners } from './session-dependency-native.test-fixture'

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

function seed(): WorkspaceSessionState {
  const root = addWorkspace(emptySession(), GIT_KEY, [
    { id: 'group', tabs: [{ id: 'tab', leaves: [[leaf(1), 'pty']] }] }
  ])
  addWorkspace(root, FOLDER_KEY, [
    { id: 'folder-group', tabs: [{ id: 'folder-tab', leaves: [[leaf(2)]] }] }
  ])
  root.tabsByWorktree['ssh:remote|repo::/work'] = [
    makeTerminalTab({ id: 'tab', worktreeId: 'ssh:remote|repo::/work' })
  ]
  root.openFilesByWorktree = {
    [GIT_KEY]: [
      { filePath: '/draft', relativePath: 'draft', language: 'text', worktreeId: GIT_KEY }
    ]
  }
  root.markdownFrontmatterVisible = { '/draft': true }
  root.browserPagesByWorkspace = {
    browser: [
      {
        id: 'page',
        workspaceId: 'browser',
        worktreeId: FOLDER_KEY,
        url: 'about:blank',
        title: '',
        loading: false,
        faviconUrl: null,
        canGoBack: false,
        canGoForward: false,
        loadError: null,
        createdAt: 1
      }
    ]
  }
  for (const [index, owner] of ['repo-1::/second', 'repo-1::/third', 'repo-2::/second'].entries()) {
    addWorkspace(root, owner, [
      {
        id: `extra-group-${index}`,
        tabs: [{ id: `extra-${index}`, leaves: [[leaf(index + 5), `extra-pty-${index}`]] }]
      }
    ])
  }
  return root
}

function policyOracle(
  reader: SessionUnitReader,
  root: WorkspaceSessionState,
  phase: 'prior' | 'candidate'
) {
  const tabs = buildWorktreeIdByTabId(root),
    files = buildWorktreeIdByFileId(root)
  for (const field of SESSION_MAP_FIELDS) {
    for (const [key, entry] of Object.entries(root[field] ?? {})) {
      expect(reader.dataOwner(field, key, phase)).toBe(
        workspaceSessionEntryOwner(field, tabs, files)?.(key, entry) ?? undefined
      )
    }
  }
}

describe('reader dependency answers over native roots', () => {
  it('seals both phases, preserves removed owners and keeps exact entities separate', () => {
    const state = { workspaceSession: freeze(seed()) }
    const publication = sessionPublication(state)
    for (const edit of [
      (reader: SessionUnitReader) =>
        reader.write('localOnlyScrollbackByTabId', 'tab', {
          present: true,
          value: { [leaf(1)]: 'buffer' }
        }),
      (reader: SessionUnitReader) =>
        reader.write('remoteSessionIdsByTabId', 'tab', { present: true, value: 'ssh:remote@@pty' }),
      (reader: SessionUnitReader) =>
        reader.write('markdownFrontmatterVisible', '/draft', { present: true, value: false }),
      (reader: SessionUnitReader) =>
        reader.write('browserPagesByWorkspace', 'browser', { present: false, value: undefined }),
      (reader: SessionUnitReader) =>
        reader.write('tabsByWorktree', GIT_KEY, { present: false, value: undefined }),
      (reader: SessionUnitReader) => reader.replace('tabsByWorktree', { present: true, value: {} })
    ]) {
      const { root, index } = publication.partition('local')
      const before = structuredClone(root)
      const reader = new SessionUnitReader(root, index)
      edit(reader)
      expect(reader.selection()).toBe(reader.selection())
      policyOracle(reader, root, 'prior')
      policyOracle(reader, reader.snapshot(), 'candidate')
      const prepared = reader.prepare({ kind: 'authoritative' })
      expect(prepared.affected.owners).toEqual(nativeAffectedOwners(root, prepared.root))
      const event = publishSessionChanges(state, 'local', prepared)
      expect(event.owners).toEqual(prepared.affected.owners)
      expect(event.pages.size).toBe(
        event.units.some((unit) => unit.field === 'browserPagesByWorkspace') ? 1 : 0
      )
      expect(root).toStrictEqual(before)
      freeze(state.workspaceSession)
      publication.take('local')
    }
  })

  it('resolves unified-only and orphan policy owners without inventing graph ownership', () => {
    const root = seed()
    root.tabsByWorktree = {}
    root.closedTerminalTabTombstonesByTabId = { orphan: { worktreeId: GIT_KEY, closedAt: 1 } }
    root.openFilesByWorktree!.later = [
      { ...root.openFilesByWorktree![GIT_KEY][0], worktreeId: FOLDER_KEY }
    ]
    freeze(root)
    const reader = new SessionUnitReader(root, new SessionUnitIndex(root))
    policyOracle(reader, root, 'prior')
    expect(reader.dataOwner('terminalLayoutsByTabId', 'tab')).toBe(GIT_KEY)
    expect(reader.dataOwner('terminalLayoutsByTabId', 'missing')).toBeUndefined()
    expect(reader.dataOwner('closedTerminalTabTombstonesByTabId', 'orphan')).toBe(GIT_KEY)
    expect(reader.dataOwner('markdownFrontmatterVisible', '/draft')).toBe(FOLDER_KEY)
    expect(reader.dataOwner('markdownFrontmatterVisible', '/draft', 'candidate', 'first')).toBe(
      GIT_KEY
    )
    reader.write('unifiedTabs', GIT_KEY, { present: false, value: undefined })
    expect(reader.dataOwner('terminalLayoutsByTabId', 'tab')).toBeUndefined()
    expect(reader.dataOwner('terminalLayoutsByTabId', 'tab', 'prior')).toBe(GIT_KEY)
  })

  it('visits a shared reference fan-out once rather than once for each record', () => {
    const root = seed()
    root.closedTerminalTabTombstonesByTabId = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`closed-${i}`, { worktreeId: GIT_KEY, closedAt: i }])
    )
    const reader = new SessionUnitReader(freeze(root), new SessionUnitIndex(root))
    reader.write('remoteSessionIdsByTabId', 'tab', { present: true, value: 'pty' })
    const references = vi.spyOn(reader, 'references')
    const scope = reader.selection()
    expect(scope.get('closedTerminalTabTombstonesByTabId')?.size).toBe(200)
    expect(
      references.mock.calls.filter(([kind, id]) => kind === 'owner' && id === GIT_KEY)
    ).toHaveLength(2)
    expect(reader.selection()).toBe(scope)
  })

  it('refreshes dependencies after reducer edits and retains explicit absent owner identities', () => {
    const root = freeze(seed()),
      reader = new SessionUnitReader(root, new SessionUnitIndex(root))
    const first = reader.selectReferences([{ kind: 'owner', id: 'repo::/absent' }])
    expect(reader.affectedOwners(first).has('repo::/absent')).toBe(true)
    reader.write('tabsByWorktree', 'repo::/new', {
      present: true,
      value: [makeTerminalTab({ id: 'tab', worktreeId: 'repo::/new' })]
    })
    expect(reader.selection()).not.toBe(first)
    expect(reader.dataOwner('terminalLayoutsByTabId', 'tab')).toBe('repo::/new')
    expect(reader.dataOwner('terminalLayoutsByTabId', 'tab', 'prior')).toBe(
      'ssh:remote|repo::/work'
    )
    expect(reader.terminalOwner('tab', 'first')).toBe(GIT_KEY)
    expect(reader.terminalOwner('tab', 'last')).toBe('repo::/new')
    const prepared = reader.prepare({ kind: 'rollback' })
    expect(prepared.affected.owners.has('repo::/absent')).toBe(true)
    expect(() =>
      reader.write('tabsByWorktree', 'x', { present: false, value: undefined })
    ).not.toThrow()
    expect(() => reader.write('tabsByWorktree', 'x', { present: true, value: [] })).toThrow(
      'sealed'
    )
  })
})
