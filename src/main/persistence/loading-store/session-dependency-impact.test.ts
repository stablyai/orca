import { describe, expect, it, vi } from 'vitest'
import type { StreamStore } from '../../runtime/workspace-layout-stream-types'
import { WorkspaceLayoutStream } from '../../runtime/workspace-layout-stream'
import * as layoutLoad from '../../../shared/workspace-layout/workspace-layout-load'
import { SessionUnitReader } from '../../../shared/session-unit-reader'
import type { SessionOperationRoot } from '../../../shared/session-unit-selection'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  addWorkspace,
  emptySession,
  leaf
} from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { nativeDependencyScope } from './session-dependency-native.test-fixture'
import { publishSessionChanges, sessionPublication } from './session-publication'

const A = 'repo-a::/one',
  B = 'repo-b::/one'
const owners = [A, 'repo-a::/two', 'repo-a::/three', B, 'repo-b::/two', 'repo-b::/three']
const revisionField = 'terminalTopologyRevisionByRepoId'

function fixture(): WorkspaceSessionState {
  const root = emptySession()
  for (const [index, owner] of owners.entries()) {
    addWorkspace(root, owner, [
      {
        id: `group-${index}`,
        tabs: [{ id: `tab-${index}`, leaves: [[leaf(index + 1), `pty-${index}`]] }]
      }
    ])
  }
  root.terminalTopologyRevisionByRepoId = { 'repo-a': 7, 'repo-b': 3 }
  return root
}

function freeze(value: unknown): void {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
}

function title(reader: SessionUnitReader, model: WorkspaceSessionState, owner = B) {
  const rows = model.tabsByWorktree[owner].map((row) => ({ ...row, title: 'later' }))
  reader.write('tabsByWorktree', owner, { present: true, value: rows })
  return { ...model, tabsByWorktree: { ...model.tabsByWorktree, [owner]: rows } }
}

function verify(
  prior: WorkspaceSessionState,
  operate: (reader: SessionUnitReader) => WorkspaceSessionState,
  roots: readonly SessionOperationRoot[] = [],
  kind: 'authoritative' | 'rollback' = 'authoritative'
) {
  freeze(prior)
  const saved = structuredClone(prior),
    state = { workspaceSession: prior }
  const publication = sessionPublication(state),
    { index } = publication.partition('local')
  const reader = new SessionUnitReader(prior, index)
  const model = operate(reader)
  reader.selectReferences(roots)
  const oracle = nativeDependencyScope(prior, model, roots)
  const scope = reader.selection()
  expect(scope).toEqual(oracle.selected)
  expect(reader.affectedOwners(scope)).toEqual(oracle.owners)
  const effects: string[] = []
  const prepared = reader.prepare({ kind, effects: [() => effects.push('once')] })
  expect(prepared.root).toStrictEqual(model)
  expect(prepared.affected.units).toEqual(oracle.selected)
  expect(prepared.affected.owners).toEqual(oracle.owners)
  expect(
    new Set(
      prepared.units.filter((unit) => unit.key !== null).map(({ field, key }) => `${field}:${key}`)
    )
  ).toEqual(new Set(oracle.changes.map(({ field, key }) => `${field}:${key}`)))
  expect(reader.selection()).toBe(prepared.affected.units)
  const event = publishSessionChanges(state, 'local', prepared)
  expect(event.owners).toEqual(oracle.owners)
  for (const notice of publication.take('local')) {
    expect(notice.owners).toEqual(oracle.owners)
  }
  expect(effects).toEqual(['once'])
  expect(prior).toStrictEqual(saved)
  expect(state.workspaceSession).toStrictEqual(model)
  expect(() => reader.selectReferences([{ kind: 'repo', id: 'new-repo' }])).toThrow('sealed')
  return { reader, prepared, event, model }
}

describe('key-specific dependency impact over independent native roots', () => {
  it.each(['absent', 'own-undefined', 'empty', 'populated'] as const)(
    '%s revision shape retains presence without granting repo reverse edges',
    (shape) => {
      const prior = fixture()
      if (shape === 'absent') {
        delete prior.terminalTopologyRevisionByRepoId
      } else if (shape === 'own-undefined') {
        Object.assign(prior, { terminalTopologyRevisionByRepoId: undefined })
      } else if (shape === 'empty') {
        prior.terminalTopologyRevisionByRepoId = {}
      }
      const { event, prepared } = verify(prior, (reader) => {
        const model = title(reader, prior)
        if (reader.policy(revisionField, 'prior')) {
          reader.reconcileField(revisionField, {
            kind: 'output',
            present: true,
            explicitEmpty: true
          })
        }
        return model
      })
      expect([...event.owners]).toEqual([B])
      expect(Object.hasOwn(prepared.root, revisionField)).toBe(Object.hasOwn(prior, revisionField))
      expect(prepared.root.terminalTopologyRevisionByRepoId).toBe(
        prior.terminalTopologyRevisionByRepoId
      )
    }
  )

  it('invalidates cached impact after set then restore, keeping historical keys out of scope', () => {
    const prior = fixture()
    const { event } = verify(prior, (reader) => {
      reader.write(revisionField, 'repo-a', { present: true, value: 8 })
      expect(reader.unitChanged(revisionField, 'repo-a')).toBe(true)
      expect(reader.affectedOwners().size).toBe(3)
      reader.write(revisionField, 'repo-a', { present: true, value: 7 })
      expect(reader.unitChanged(revisionField, 'repo-a')).toBe(false)
      return title(reader, prior)
    })
    expect([...event.owners]).toEqual([B])
  })

  it('changes repo A alongside a title in repo B without selecting B peers', () => {
    const prior = fixture()
    const { event } = verify(prior, (reader) => {
      reader.write(revisionField, 'repo-a', { present: true, value: 8 })
      return {
        ...title(reader, prior),
        terminalTopologyRevisionByRepoId: { ...prior.terminalTopologyRevisionByRepoId, 'repo-a': 8 }
      }
    })
    expect(event.owners).toEqual(new Set([...owners.slice(0, 3), B]))
  })

  it('deletes a revision key while retaining its prior repo dependents', () => {
    const prior = fixture()
    const { event } = verify(prior, (reader) => {
      reader.write(revisionField, 'repo-a', { present: false, value: undefined })
      return { ...prior, terminalTopologyRevisionByRepoId: { 'repo-b': 3 } }
    })
    expect(event.owners).toEqual(new Set(owners.slice(0, 3)))
  })

  it('clears then adds, comparing the complete normalized result against the captured root', () => {
    const prior = fixture()
    const { event } = verify(prior, (reader) => {
      reader.replace(revisionField, { present: true, value: {} })
      reader.write(revisionField, 'repo-a', { present: true, value: 8 })
      return { ...prior, terminalTopologyRevisionByRepoId: { 'repo-a': 8 } }
    })
    expect(event.owners).toEqual(new Set(owners))
  })

  it('preserves a complete remove/reinsert order boundary without value impact', () => {
    const prior = fixture(),
      reordered = { 'repo-b': 3, 'repo-a': 7 }
    const { reader, event, prepared } = verify(prior, (source) => {
      source.replace(revisionField, { present: true, value: reordered })
      return { ...title(source, prior), terminalTopologyRevisionByRepoId: reordered }
    })
    expect(reader.keys(revisionField)).toEqual(Object.keys(reordered))
    expect(prepared.orders.get(revisionField)).toEqual(Object.keys(reordered))
    expect([...event.owners]).toEqual([B])
  })

  it('retains explicit repo operations separately from an unchanged policy address', () => {
    const prior = fixture()
    const { event } = verify(prior, (reader) => title(reader, prior), [
      { kind: 'repo', id: 'repo-a' }
    ])
    expect(event.owners).toEqual(new Set([...owners.slice(0, 3), B]))
  })

  it('retains absent typed owners and repos without inventing a value change', () => {
    const prior = fixture()
    const { event } = verify(prior, () => prior, [
      { kind: 'owner', id: 'repo-a::/absent' },
      { kind: 'repo', id: 'absent-repo' }
    ])
    expect([...event.owners]).toEqual(['repo-a::/absent'])
  })

  it('retains old and new duplicate owners across a move and rollback', () => {
    const prior = fixture()
    const duplicate = prior.tabsByWorktree[A].map((row) => ({ ...row, worktreeId: owners[1] }))
    prior.tabsByWorktree[owners[1]] = duplicate
    const moved = prior.tabsByWorktree[A].map((row) => ({ ...row, worktreeId: B }))
    const next = verify(prior, (reader) => {
      reader.write('tabsByWorktree', A, { present: false, value: undefined })
      reader.write('tabsByWorktree', B, { present: true, value: moved })
      const rows = { ...prior.tabsByWorktree, [B]: moved }
      delete rows[A]
      return { ...prior, tabsByWorktree: rows }
    }).model
    verify(
      next,
      (reader) => {
        reader.write('tabsByWorktree', A, { present: true, value: prior.tabsByWorktree[A] })
        reader.write('tabsByWorktree', B, { present: true, value: prior.tabsByWorktree[B] })
        return {
          ...next,
          tabsByWorktree: {
            ...next.tabsByWorktree,
            [A]: prior.tabsByWorktree[A],
            [B]: prior.tabsByWorktree[B]
          }
        }
      },
      [],
      'rollback'
    )
  })
})

it('loads only the edited owner and its three pane titles among 50 same-repo workspaces', () => {
  const root = emptySession()
  for (let i = 0; i < 50; i++) {
    const pane = (n: number) => `${n.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`
    addWorkspace(root, `repo::/${i}`, [
      {
        id: `group-${i}`,
        tabs: [
          {
            id: `tab-${i}-a`,
            leaves: [
              [pane(i * 3), `pty-${i}-a`],
              [pane(i * 3 + 1), `pty-${i}-b`]
            ]
          },
          { id: `tab-${i}-b`, leaves: [[pane(i * 3 + 2), `pty-${i}-c`]] }
        ]
      }
    ])
  }
  root.terminalTopologyRevisionByRepoId = {}
  freeze(root)
  const state = { workspaceSession: root },
    publication = sessionPublication(state)
  const loaded: string[][] = [],
    titles: string[] = []
  let notify: Parameters<NonNullable<StreamStore['onWorkspaceSessionWritten']>>[0] | undefined
  const store: StreamStore = {
    getWorkspaceSession: () => state.workspaceSession,
    getWorkspaceSessionHostIds: () => ['local'],
    getWorkspaceSessionReferences: (kind, id) =>
      publication.partition('local').index.references(kind, id),
    readWorkspaceSessionUnits: (owners) => {
      const { root: prior, index } = publication.partition('local')
      const reader = new SessionUnitReader(prior, index)
      const selected = reader.selectReferences(owners.map((id) => ({ kind: 'owner', id })))
      return {
        reader: reader.view('candidate'),
        selected,
        owners: [...reader.affectedOwners(selected)]
      }
    },
    onWorkspaceSessionWritten: (listener) => {
      notify = listener
      return () => {
        notify = undefined
      }
    }
  }
  const stream = new WorkspaceLayoutStream({
    store: () => store,
    homeHostId: () => 'local',
    liveTitle: (pty) => {
      titles.push(pty)
      return null
    }
  })
  const subscription = stream.subscribe(() => {})
  titles.length = 0
  const load = layoutLoad.loadWorkspaceLayoutUnits
  const spy = vi.spyOn(layoutLoad, 'loadWorkspaceLayoutUnits').mockImplementation((...args) => {
    loaded.push([...args[2]])
    return load(...args)
  })
  try {
    const reader = new SessionUnitReader(root, publication.partition('local').index)
    const rows = root.tabsByWorktree['repo::/0'].map((row) => ({ ...row, title: 'later' }))
    reader.write('tabsByWorktree', 'repo::/0', { present: true, value: rows })
    reader.reconcileField(revisionField, { kind: 'output', present: true, explicitEmpty: true })
    const prepared = reader.prepare({ kind: 'renderer' })
    const native = { ...root, tabsByWorktree: { ...root.tabsByWorktree, 'repo::/0': rows } }
    expect(prepared.affected.owners).toEqual(nativeDependencyScope(root, native).owners)
    const event = publishSessionChanges(state, 'local', prepared)
    expect([...event.owners]).toEqual(['repo::/0'])
    notify?.('local', [event])
    stream.settledSeq()
    expect(loaded).toEqual([['repo::/0']])
    expect(titles).toEqual(['pty-0-a', 'pty-0-b', 'pty-0-c'])
    expect(root.tabsByWorktree['repo::/0'][0].title).not.toBe('later')
  } finally {
    subscription.unsubscribe()
    spy.mockRestore()
  }
})
