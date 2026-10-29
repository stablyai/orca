import {
  type SessionAdmissionKind,
  type SessionMapDeltas,
  SESSION_MAP_FIELDS
} from '../../../shared/session-change-set'
import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { TerminalTab } from '../../../shared/terminal-tab-types'

import { SessionUnitIndex } from '../../../shared/session-unit-index'
import { publishSessionChanges, sessionPublication } from './session-publication'
import { SessionUnitReader, selectSessionUnits } from '../../../shared/session-unit-reader'

function tab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    worktreeId,
    ptyId: null,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) {
      freeze(child)
    }
    Object.freeze(value)
  }
  return value
}

function publishEdits(
  state: { workspaceSession: ReturnType<typeof getDefaultWorkspaceSession> },
  admission: {
    kind: SessionAdmissionKind
    mapDeltas: SessionMapDeltas
  }
): void {
  const { root, index } = sessionPublication(state).partition('local')
  const reader = new SessionUnitReader(root, index)
  for (const field of SESSION_MAP_FIELDS) {
    const delta = admission.mapDeltas[field]
    for (const key of delta?.remove ?? []) {
      reader.write(field, key, { present: false, value: undefined })
    }
    for (const [key, value] of Object.entries(delta?.set ?? {})) {
      reader.write(field, key, { present: true, value })
    }
  }
  publishSessionChanges(state, 'local', reader.prepare({ kind: admission.kind }))
}

describe('immutable session publication', () => {
  it('keeps frozen snapshots isolated and versions units even after a value is restored', () => {
    const first = [tab('a', 'repo::/a')]
    const untouched = [tab('b', 'repo::/b')]
    const prior = freeze({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { 'repo::/a': first, 'repo::/b': untouched }
    })
    const state = { workspaceSession: prior }
    const publication = sessionPublication(state)
    const generation = publication.generation('local')
    const next = [tab('a', 'repo::/a'), tab('c', 'repo::/a')]
    publishEdits(state, {
      kind: 'authoritative',
      mapDeltas: { tabsByWorktree: { set: { 'repo::/a': next } } }
    })
    expect(state.workspaceSession.tabsByWorktree['repo::/b']).toBe(untouched)
    expect(prior.tabsByWorktree['repo::/a']).toBe(first)
    expect(publication.version('local', 'tabsByWorktree', 'repo::/a')).toBe(1)
    expect(publication.generation('local')).not.toBe(generation)
    publishEdits(state, {
      kind: 'rollback',
      mapDeltas: { tabsByWorktree: { set: { 'repo::/a': first } } }
    })
    expect(publication.version('local', 'tabsByWorktree', 'repo::/a')).toBe(2)
    expect(prior.tabsByWorktree['repo::/a']).toEqual([tab('a', 'repo::/a')])
    const settledGeneration = publication.generation('local')
    publication.take()
    publishEdits(state, { kind: 'authoritative', mapDeltas: {} })
    expect(publication.generation('local')).toBe(settledGeneration)
    expect(publication.take()).toEqual([])
  })

  it('announces the owning workspace when only its pane order changes', () => {
    const owner = 'repo::/a'
    const first = '11111111-1111-4111-8111-111111111111'
    const second = '22222222-2222-4222-8222-222222222222'
    const session = getDefaultWorkspaceSession()
    session.tabsByWorktree = { [owner]: [tab('a', owner)] }
    session.terminalLayoutsByTabId = {
      a: {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: first },
          second: { type: 'leaf', leafId: second }
        },
        activeLeafId: first,
        expandedLeafId: null
      }
    }
    const prior = freeze(session)
    const state = { workspaceSession: prior }
    const publication = sessionPublication(state)
    const { root, index } = publication.partition('local')
    const reader = new SessionUnitReader(root, index)
    reader.write('terminalLayoutsByTabId', 'a', {
      present: true,
      value: {
        ...session.terminalLayoutsByTabId.a,
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: second },
          second: { type: 'leaf', leafId: first }
        }
      }
    })
    expect([...(selectSessionUnits(reader).get('tabsByWorktree') ?? [])]).toEqual([owner])
    publishSessionChanges(state, 'local', reader.prepare({ kind: 'renderer' }))
    expect(state.workspaceSession.terminalLayoutsByTabId.a.root).not.toBe(
      prior.terminalLayoutsByTabId.a.root
    )
    expect([...publication.take('local')[0].owners]).toEqual([owner])
  })

  it('matches rebuilt ownership, order, duplicate and scrollback counts after keyed edits', () => {
    const state = { workspaceSession: getDefaultWorkspaceSession() }
    const publication = sessionPublication(state)
    const owners = ['12', '2', 'repo::/a', 'repo::/b']
    const leaf = '11111111-1111-4111-8111-111111111111'
    for (let step = 0; step < 32; step += 1) {
      const owner = owners[(step * 7) % owners.length]
      const id = `tab-${step % 3}`
      const rows = step % 5 === 0 ? [tab(id, owner), tab(id, owner)] : [tab(id, owner)]
      publishEdits(state, {
        kind: 'authoritative',
        mapDeltas: {
          tabsByWorktree: step % 7 === 0 ? { remove: [owner] } : { set: { [owner]: rows } },
          terminalLayoutsByTabId: {
            set: {
              [id]: {
                root: { type: 'leaf', leafId: leaf },
                activeLeafId: leaf,
                expandedLeafId: null,
                scrollbackRefsByLeafId: { [leaf]: 'same-ref', other: 'same-ref' }
              }
            }
          }
        }
      })
      const rebuilt = new SessionUnitIndex(state.workspaceSession)
      const actual = publication.partition('local').index
      for (const name of ['tab-0', 'tab-1', 'tab-2']) {
        expect(actual.terminalOwner(name, 'first')).toBe(rebuilt.terminalOwner(name, 'first'))
        expect(actual.terminalOwner(name, 'last')).toBe(rebuilt.terminalOwner(name, 'last'))
        expect(actual.terminalOccurrenceCount(name)).toBe(rebuilt.terminalOccurrenceCount(name))
        expect(actual.references('tab', name)).toEqual(rebuilt.references('tab', name))
      }
      expect(actual.scrollbackCount('same-ref')).toBe(6 - Math.max(0, 2 - step) * 2)
      for (const field of SESSION_MAP_FIELDS) {
        expect(actual.ordered(field, owners)).toEqual(rebuilt.ordered(field, owners))
      }
      freeze(state.workspaceSession)
    }
  })

  it('closes over co-owners without inspecting an unrelated bucket', () => {
    const unrelated = new Proxy([tab('unrelated', 'other::/x')], {
      get(target, property) {
        if (property === Symbol.iterator) {
          throw new Error('unrelated bucket inspected')
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this proxy forwards the array's native keys unchanged.
        return target[property as keyof typeof target]
      }
    })
    const state = {
      workspaceSession: {
        ...getDefaultWorkspaceSession(),
        tabsByWorktree: {
          'repo::/a': [tab('shared', 'repo::/a')],
          'repo::/b': [tab('shared', 'repo::/b')],
          'other::/x': [tab('unrelated', 'other::/x')]
        }
      }
    }
    sessionPublication(state).partition('local')
    // The index is populated at the full boundary before ordinary reads are instrumented.
    Object.defineProperty(state.workspaceSession.tabsByWorktree, 'other::/x', { value: unrelated })
    const { root, index } = sessionPublication(state).partition('local')
    const reader = new SessionUnitReader(root, index)
    reader.write('tabsByWorktree', 'repo::/a', {
      present: true,
      value: [tab('shared', 'repo::/a')]
    })
    const scope = selectSessionUnits(reader)
    expect([...(scope.get('tabsByWorktree') ?? [])]).toEqual(['repo::/a', 'repo::/b'])
    expect(scope.get('tabsByWorktree')?.has('other::/x')).toBe(false)
  })
})

describe('native Record order differential', () => {
  it('keeps candidate reads, references, selection and committed order in one domain', () => {
    const state = { workspaceSession: getDefaultWorkspaceSession() }
    const publication = sessionPublication(state)
    const field = 'tabsByWorktree'
    const keys = ['2', 'other', '01', '4294967295', '4294967294', '-0', '1']
    type Edit = {
      set?: string
      remove?: string
      replacement?: readonly string[]
      ownUndefined?: string
    }
    const edits: Edit[] = [
      ...keys.map((set) => ({ set })),
      { set: 'other' },
      { remove: 'other' },
      { set: 'other' },
      { ownUndefined: 'orphan' },
      { replacement: ['other', '01', '2', '1', '-0', '4294967295', '4294967294'] },
      { replacement: [] },
      { set: 'clear-then-add' },
      { set: '0' },
      { set: '3' }
    ]
    let native: typeof state.workspaceSession.tabsByWorktree = {}
    for (const edit of edits) {
      const prior = freeze(state.workspaceSession)
      const saved = structuredClone(prior)
      const reader = new SessionUnitReader(prior, publication.partition('local').index)
      const previousKeys = Object.keys(native)
      if (edit.replacement) {
        native = Object.fromEntries(edit.replacement.map((key) => [key, [tab('duplicate', key)]]))
        reader.replace(field, { present: true, value: native })
      } else {
        native = { ...native }
        if (edit.remove) {
          delete native[edit.remove]
          reader.write(field, edit.remove, { present: false, value: undefined })
        }
        if (edit.set) {
          native[edit.set] = [tab('duplicate', edit.set)]
          reader.write(field, edit.set, { present: true, value: native[edit.set] })
        }
        if (edit.ownUndefined) {
          // SAFETY: deliberately exercise orphan own-undefined properties admitted by legacy snapshots.
          Object.assign(native, { [edit.ownUndefined]: undefined })
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this malformed legacy own-undefined entry deliberately falls outside the valid saved DTO.
          reader.write(field, edit.ownUndefined, { present: true, value: undefined as never })
        }
      }
      const nativeKeys = Object.keys(native)
      const selected = new Set([...nativeKeys].toReversed())
      expect(reader.keys(field)).toEqual(nativeKeys)
      expect(Object.keys(reader.map(field, selected))).toEqual(nativeKeys)
      expect(reader.snapshot().tabsByWorktree).toStrictEqual(native)
      const owners = nativeKeys.filter((key) => native[key]?.some((row) => row.id === 'duplicate'))
      expect(
        reader
          .references('tab', 'duplicate')
          .filter((unit) => unit.field === field)
          .map((unit) => unit.key)
      ).toEqual(owners)
      expect(reader.terminalOwner('duplicate', 'first')).toBe(owners[0])
      expect(reader.terminalOwner('duplicate', 'last')).toBe(owners.at(-1))
      const selection = selectSessionUnits(
        reader,
        nativeKeys.map((key) => ({ field, key }))
      )
      expect([...(selection.get(field) ?? [])].filter((key) => Object.hasOwn(native, key))).toEqual(
        nativeKeys
      )
      for (const removed of previousKeys.filter((key) => !Object.hasOwn(native, key))) {
        expect(selection.get(field)?.has(removed)).toBe(true)
      }
      publishSessionChanges(state, 'local', reader.prepare({ kind: 'authoritative' }))
      expect(Object.keys(state.workspaceSession.tabsByWorktree)).toEqual(nativeKeys)
      expect([...publication.partition('local').index.keys(field)]).toEqual(nativeKeys)
      const rebuilt = new SessionUnitIndex(state.workspaceSession)
      expect(publication.partition('local').index.references('tab', 'duplicate')).toEqual(
        rebuilt.references('tab', 'duplicate')
      )
      expect(prior).toStrictEqual(saved)
    }
    const prior = freeze(state.workspaceSession)
    const reader = new SessionUnitReader(prior, publication.partition('local').index)
    const sameOperation = { ...native }
    delete sameOperation['clear-then-add']
    sameOperation['clear-then-add'] = [tab('duplicate', 'clear-then-add')]
    reader.replace(field, { present: true, value: sameOperation })
    expect(reader.keys(field)).toEqual(Object.keys(sameOperation))
    publishSessionChanges(state, 'local', reader.prepare({ kind: 'authoritative' }))
    expect([...publication.partition('local').index.keys(field)]).toEqual(
      Object.keys(sameOperation)
    )
  })
})

describe('sealed resolved publication', () => {
  it('installs the exact cached root and presence receipts while running prepared effects once', () => {
    const prior = freeze({
      ...getDefaultWorkspaceSession(),
      terminalPtyIncarnationsByPaneKey: { prior: 'old' }
    })
    const state = { workspaceSession: prior }
    const publication = sessionPublication(state)
    const reader = new SessionUnitReader(prior, publication.partition('local').index)
    reader.replace('terminalPtyIncarnationsByPaneKey', { present: true, value: undefined })
    reader.write('terminalPtyIncarnationsByPaneKey', 'ownUndefined', {
      present: true,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the invariant deliberately exercises an invalid own-undefined incarnation from legacy ingress.
      value: undefined as never
    })
    const snapshot = freeze(reader.snapshot())
    let effects = 0
    const prepared = reader.prepare({
      kind: 'authoritative',
      effects: [
        () => {
          effects += 1
          expect(state.workspaceSession).toBe(snapshot)
        }
      ]
    })
    const event = publishSessionChanges(state, 'local', prepared)
    expect(state.workspaceSession).toBe(snapshot)
    expect(reader.snapshot()).toBe(snapshot)
    expect(effects).toBe(1)
    expect(event.units).toContainEqual({
      field: 'terminalPtyIncarnationsByPaneKey',
      key: 'ownUndefined',
      prior: undefined,
      next: undefined,
      priorPresent: false,
      nextPresent: true
    })
    expect(event.units).toContainEqual({
      field: 'terminalPtyIncarnationsByPaneKey',
      key: 'prior',
      prior: 'old',
      next: undefined,
      priorPresent: true,
      nextPresent: false
    })
    expect(
      publication.partition('local').index.has('terminalPtyIncarnationsByPaneKey', 'ownUndefined')
    ).toBe(true)
    expect(prior.terminalPtyIncarnationsByPaneKey).toStrictEqual({ prior: 'old' })
  })
})
