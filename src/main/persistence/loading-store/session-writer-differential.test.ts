import { nativeAffectedOwners } from './session-dependency-native.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../../shared/constants'

import {
  reduceSessionTerminalRetirements,
  sanitizeWorkspaceSessionTerminalRetirements
} from '../../runtime/mobile-session-terminal-persistence-retirement'
import {
  reduceSessionTerminalMembership,
  reduceSessionIncarnationMembership
} from '../../runtime/workspace-session-terminal-membership-authority'
import {
  reduceClosedTerminalTabPruning,
  reduceClosedTerminalTabFence
} from '../closed-terminal-tab-write-fence'
import { patchSessionUnits } from '../../../shared/workspace-layout/workspace-layout-record-patch'
import { SESSION_MAP_FIELDS } from '../../../shared/session-change-set'
import { SessionUnitIndex } from '../../../shared/session-unit-index'
import { SessionUnitReader, selectSessionUnits } from '../../../shared/session-unit-reader'
import {
  addWorkspace,
  emptySession,
  GIT_KEY,
  leaf
} from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { StoreRuntimeState } from './store-runtime-state'
import { createStoreDomains } from './store-domain-composition'
import { getSessionSnapshotOperationsContext } from './session-snapshot-operations'
import { publishWorkspaceSessionSnapshot } from './workspace-session-snapshot-publication'
import { migrateWorkspaceSessionTerminalScrollbackSnapshotsAsync } from '../../terminal-scrollback-snapshot-async-migration'
import { fullSessionSelection } from './session-full-enumeration.test-fixture'
import { initializeSessionPublication, sessionPublication } from './session-publication'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, safeStorage: {} }))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      freeze(child)
    }
    Object.freeze(value)
  }
  return value
}

function context(session: WorkspaceSessionState, home: string) {
  const runtime = new StoreRuntimeState({ dataFile: join(home, 'orca-data.json') })
  runtime.state = { ...getDefaultPersistedState(home), workspaceSession: session }
  runtime.writesFrozen = true
  const domains = createStoreDomains(runtime)
  initializeSessionPublication(runtime.state)
  return {
    runtime,
    domains,
    snapshot: getSessionSnapshotOperationsContext(domains.sessionSnapshots)
  }
}

const homes: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true })
  }
})

const edits: readonly {
  name: string
  edit(reader: SessionUnitReader): void
  native(root: WorkspaceSessionState): WorkspaceSessionState
}[] = [
  {
    name: 'terminal title',
    native: (root) => ({
      ...root,
      tabsByWorktree: {
        ...root.tabsByWorktree,
        [GIT_KEY]: root.tabsByWorktree[GIT_KEY].map((row) => ({ ...row, title: 'later' }))
      }
    }),
    edit: (reader) => {
      const rows = reader.unit('tabsByWorktree', GIT_KEY).value!
      reader.write('tabsByWorktree', GIT_KEY, {
        present: true,
        value: rows.map((row) => ({ ...row, title: 'later' }))
      })
    }
  },
  {
    name: 'layout-only binding removal',
    native: (root) => ({
      ...root,
      terminalLayoutsByTabId: {
        ...root.terminalLayoutsByTabId,
        'tab-a': { ...root.terminalLayoutsByTabId['tab-a'], ptyIdsByLeafId: {} }
      }
    }),
    edit: (reader) => {
      const layout = reader.unit('terminalLayoutsByTabId', 'tab-a').value!
      reader.write('terminalLayoutsByTabId', 'tab-a', {
        present: true,
        value: { ...layout, ptyIdsByLeafId: {} }
      })
    }
  },
  {
    name: 'last sleep removal',
    native: (root) => {
      const next = { ...root.sleepingAgentSessionsByPaneKey }
      delete next[`tab-a:${leaf(1)}`]
      const result: WorkspaceSessionState = { ...root, sleepingAgentSessionsByPaneKey: next }
      if (!Object.keys(next).length) {
        delete result.sleepingAgentSessionsByPaneKey
      }
      return result
    },
    edit: (reader) =>
      reader.write('sleepingAgentSessionsByPaneKey', `tab-a:${leaf(1)}`, {
        present: false,
        value: undefined
      })
  },
  {
    name: 'last incarnation removal',
    native: (root) => {
      const next = { ...root.terminalPtyIncarnationsByPaneKey }
      delete next[`tab-a:${leaf(1)}`]
      const result: WorkspaceSessionState = { ...root, terminalPtyIncarnationsByPaneKey: next }
      if (!Object.keys(next).length) {
        delete result.terminalPtyIncarnationsByPaneKey
      }
      return result
    },
    edit: (reader) =>
      reader.write('terminalPtyIncarnationsByPaneKey', `tab-a:${leaf(1)}`, {
        present: false,
        value: undefined
      })
  },
  {
    name: 'explicit clear then add',
    native: (root) => ({ ...root, remoteSessionIdsByTabId: { 'tab-a': 'ssh:target@@new' } }),
    edit: (reader) => {
      reader.replace('remoteSessionIdsByTabId', { present: true, value: {} })
      reader.write('remoteSessionIdsByTabId', 'tab-a', { present: true, value: 'ssh:target@@new' })
    }
  },
  {
    name: 'membership-only patch',
    native: (root) => ({ ...root, activeWorktreeIdsOnShutdown: [GIT_KEY] }),
    edit: (reader) =>
      reader.replace('activeWorktreeIdsOnShutdown', { present: true, value: [GIT_KEY] })
  },
  {
    name: 'empty-owner topology revision',
    native: (root) => ({
      ...root,
      terminalTopologyRevisionByRepoId: { ...root.terminalTopologyRevisionByRepoId, 'repo-1': 8 }
    }),
    edit: (reader) =>
      reader.write('terminalTopologyRevisionByRepoId', 'repo-1', { present: true, value: 8 })
  }
]

describe('shared writer normalization differential', () => {
  it.each(edits)(
    '$name matches independent full selection with frozen prior units',
    ({ name, edit, native }) => {
      const home = mkdtempSync(join(tmpdir(), 'orca-session-writer-differential-'))
      homes.push(home)
      const seed = addWorkspace(emptySession(), GIT_KEY, [
        { id: 'group-a', tabs: [{ id: 'tab-a', leaves: [[leaf(1), 'pty-a']] }] }
      ])
      for (const [index, owner] of [
        'repo-1::/second',
        'repo-1::/third',
        'repo-2::/second',
        'repo-2::/third'
      ].entries()) {
        addWorkspace(seed, owner, [
          {
            id: `extra-group-${index}`,
            tabs: [{ id: `extra-${index}`, leaves: [[leaf(index + 5), `extra-pty-${index}`]] }]
          }
        ])
      }
      if (name === 'last sleep removal') {
        seed.sleepingAgentSessionsByPaneKey = {
          [`tab-a:${leaf(1)}`]: {
            paneKey: `tab-a:${leaf(1)}`,
            worktreeId: GIT_KEY,
            agent: 'codex',
            providerSession: { key: 'session_id', id: 'session-a' },
            prompt: '',
            state: 'working',
            capturedAt: 1,
            updatedAt: 1,
            origin: 'live'
          }
        }
      }
      if (name === 'last incarnation removal') {
        seed.terminalPtyIncarnationsByPaneKey = { [`tab-a:${leaf(1)}`]: 'incarnation-a' }
      }
      const prior = freeze(seed)
      const saved = structuredClone(prior)
      const keyed = context(prior, home)
      const complete = context(prior, home)
      const publication = sessionPublication(keyed.runtime.state)
      const reader = new SessionUnitReader(prior, publication.partition('local').index)
      edit(reader)
      const full = SessionUnitReader.between(prior, native(prior), new SessionUnitIndex(prior))
      publishWorkspaceSessionSnapshot(
        keyed.snapshot,
        'local',
        reader,
        false,
        false,
        selectSessionUnits(reader)
      )
      publishWorkspaceSessionSnapshot(
        complete.snapshot,
        'local',
        full,
        false,
        false,
        fullSessionSelection(full)
      )
      expect(keyed.runtime.state).toStrictEqual(complete.runtime.state)
      expect(prior).toStrictEqual(saved)
      const installed = keyed.runtime.state.workspaceSession
      const notices = publication.take('local')
      for (const event of notices) {
        expect(event.owners).toEqual(nativeAffectedOwners(prior, installed))
      }
      const actual = publication.partition('local').index
      const rebuilt = new SessionUnitIndex(installed)
      for (const field of SESSION_MAP_FIELDS) {
        expect(Object.hasOwn(installed, field)).toBe(
          Object.hasOwn(complete.runtime.state.workspaceSession, field)
        )
        expect([...actual.keys(field)]).toEqual(Object.keys(installed[field] ?? {}))
        expect([...actual.keys(field)]).toEqual([...rebuilt.keys(field)])
        expect(actual.size(field)).toBe(rebuilt.size(field))
        for (const key of rebuilt.keys(field)) {
          for (const kind of [
            'owner',
            'tab',
            'pane',
            'file',
            'browser',
            'page',
            'pty',
            'repo',
            'scrollback'
          ] as const) {
            for (const id of rebuilt.dependencyIds(field, key, kind)) {
              expect(actual.references(kind, id)).toEqual(rebuilt.references(kind, id))
            }
          }
        }
      }
    }
  )
})

describe('complete policy outputs with zero selected units', () => {
  for (const shape of ['absent', 'empty', 'populated'] as const) {
    const closed: WorkspaceSessionState['closedTerminalTabTombstonesByTabId'] =
      shape === 'absent'
        ? undefined
        : shape === 'empty'
          ? {}
          : {
              retired: { closedAt: 1, worktreeId: GIT_KEY }
            }
    it(`retirement / ${shape} emits the complete empty field and preserves the no-op boundary`, () => {
      const prior = getDefaultWorkspaceSession()
      if (shape !== 'absent') {
        prior.terminalSurfaceTombstonesByPaneKey =
          shape === 'empty'
            ? {}
            : {
                [`retired:${leaf(1)}`]: {
                  worktreeId: GIT_KEY,
                  parentTabId: 'retired',
                  leafId: leaf(1),
                  ptyId: 'gone',
                  incarnationId: 'gone-incarnation',
                  retiredAt: 1
                }
              }
      }
      prior.terminalTopologyRevisionByRepoId = shape === 'populated' ? { 'repo-1': 1 } : {}
      let enumerations = 0
      if (prior.terminalSurfaceTombstonesByPaneKey) {
        prior.terminalSurfaceTombstonesByPaneKey = new Proxy(
          prior.terminalSurfaceTombstonesByPaneKey,
          {
            ownKeys: (value) => {
              enumerations++
              return Reflect.ownKeys(value)
            }
          }
        )
      }
      freeze(prior)
      const reader = new SessionUnitReader(prior, new SessionUnitIndex(prior))
      enumerations = 0
      reduceSessionTerminalRetirements(reader, new Map())
      const result = reader.prepare({ kind: 'renderer' }).root
      expect(enumerations).toBe(0)
      expect(result.terminalSurfaceTombstonesByPaneKey).toStrictEqual({})
      expect(result).toStrictEqual(sanitizeWorkspaceSessionTerminalRetirements(prior, prior))
      const plain = freeze(getDefaultWorkspaceSession())
      expect(sanitizeWorkspaceSessionTerminalRetirements(plain, plain)).toBe(plain)
    })
    it(`close pruning / ${shape} owns the whole field without selected tab rows`, () => {
      const prior = freeze({
        ...getDefaultWorkspaceSession(),
        ...(closed === undefined
          ? {}
          : {
              closedTerminalTabTombstonesByTabId: closed
            })
      })
      const reader = new SessionUnitReader(prior, new SessionUnitIndex(prior))
      reduceClosedTerminalTabPruning(reader, 100)
      expect(Object.hasOwn(reader.snapshot(), 'closedTerminalTabTombstonesByTabId')).toBe(true)
      expect(reader.snapshot().closedTerminalTabTombstonesByTabId).toStrictEqual(closed ?? {})
    })
    it(`closed-tab fence / ${shape} leaves the complete field unchanged without selected rows`, () => {
      const prior = freeze({
        ...getDefaultWorkspaceSession(),
        ...(closed === undefined
          ? {}
          : {
              closedTerminalTabTombstonesByTabId: closed
            })
      })
      const reader = new SessionUnitReader(prior, new SessionUnitIndex(prior))
      reduceClosedTerminalTabFence(reader, [])
      expect(reader.snapshot()).toBe(prior)
    })
    it(`membership rebase / ${shape} retains the complete revision result without selected owners`, () => {
      const prior = freeze({
        ...getDefaultWorkspaceSession(),
        ...(shape === 'absent'
          ? {}
          : {
              terminalTopologyRevisionByRepoId: shape === 'empty' ? {} : { 'repo-1': 1 }
            })
      })
      const reader = new SessionUnitReader(prior, new SessionUnitIndex(prior))
      reduceSessionTerminalMembership(reader, [], [])
      expect(reader.snapshot()).toStrictEqual(prior)
    })
    it(`incarnation membership / ${shape} emits its exact complete empty result without selected panes`, () => {
      const prior = freeze({
        ...getDefaultWorkspaceSession(),
        ...(shape === 'absent'
          ? {}
          : {
              terminalPtyIncarnationsByPaneKey: shape === 'empty' ? {} : { 'other:leaf': 'inc' }
            })
      })
      const reader = new SessionUnitReader(prior, new SessionUnitIndex(prior))
      // Complete policy output supersedes an earlier explicit empty input too.
      if (shape === 'empty') {
        reader.replace('terminalPtyIncarnationsByPaneKey', { present: true, value: {} })
      }
      reduceSessionIncarnationMembership(reader, [])
      const next = reader.snapshot()
      expect(Object.hasOwn(next, 'terminalPtyIncarnationsByPaneKey')).toBe(true)
      expect(next.terminalPtyIncarnationsByPaneKey).toStrictEqual(
        shape === 'populated' ? prior.terminalPtyIncarnationsByPaneKey : undefined
      )
    })
    it(`incarnation serialization / ${shape} preserves unselected entries and exact whole output`, () => {
      const prior = freeze({
        ...getDefaultWorkspaceSession(),
        ...(shape === 'absent'
          ? {}
          : {
              terminalPtyIncarnationsByPaneKey: shape === 'empty' ? {} : { 'other:leaf': 'inc' }
            })
      })
      const before = getDefaultWorkspaceSession()
      before.terminalPtyIncarnationsByPaneKey = { 'selected:leaf': 'removed' }
      const after = getDefaultWorkspaceSession()
      after.terminalPtyIncarnationsByPaneKey = {}
      const reader = new SessionUnitReader(prior, new SessionUnitIndex(prior))
      patchSessionUnits(reader, before, after, { kind: 'selected', fields: new Map() })
      expect(reader.snapshot().terminalPtyIncarnationsByPaneKey).toStrictEqual(
        prior.terminalPtyIncarnationsByPaneKey ?? {}
      )
      expect(Object.hasOwn(reader.snapshot(), 'terminalPtyIncarnationsByPaneKey')).toBe(true)
    })
  }
})

describe('full snapshot writer adapters', () => {
  it.each(['set', 'unload'] as const)(
    '%s matches independently enumerated full normalization and snapshot-file completion',
    async (mode) => {
      vi.spyOn(Date, 'now').mockReturnValue(1700000000000)
      const home = mkdtempSync(join(tmpdir(), 'orca-snapshot-writer-differential-'))
      homes.push(home)
      const prior = freeze(
        addWorkspace(emptySession(), GIT_KEY, [
          { id: 'group-a', tabs: [{ id: 'tab-a', leaves: [[leaf(1), 'pty-a']] }] }
        ])
      )
      const saved = structuredClone(prior)
      const incoming = structuredClone(prior)
      incoming.tabsByWorktree[GIT_KEY][0].title = 'incoming'
      incoming.terminalLayoutsByTabId['tab-a'].buffersByLeafId = {
        [leaf(1)]: 'saved terminal buffer'
      }
      const keyed = context(prior, home),
        complete = context(prior, home)
      const full = SessionUnitReader.between(prior, incoming, new SessionUnitIndex(prior))
      publishWorkspaceSessionSnapshot(
        complete.snapshot,
        'local',
        full,
        true,
        mode === 'unload',
        fullSessionSelection(full)
      )
      keyed.runtime.writesFrozen = false
      try {
        if (mode === 'set') {
          keyed.domains.sessionSnapshots.setWorkspaceSession(incoming)
        } else {
          keyed.domains.sessionSnapshots.stageWorkspaceSessionBeforeUnload(incoming)
        }
      } finally {
        keyed.runtime.writesFrozen = true
        if (keyed.runtime.writeTimer) {
          clearTimeout(keyed.runtime.writeTimer)
        }
        keyed.runtime.writeTimer = null
      }
      expect(keyed.runtime.state.workspaceSession).toStrictEqual(
        complete.runtime.state.workspaceSession
      )
      const staged = freeze(keyed.runtime.state.workspaceSession),
        stagedCopy = structuredClone(staged)
      const expected =
        mode === 'unload'
          ? await migrateWorkspaceSessionTerminalScrollbackSnapshotsAsync(
              complete.runtime.state.workspaceSession,
              complete.runtime.terminalScrollbackSnapshotStorage
            )
          : complete.runtime.state.workspaceSession
      await keyed.runtime.pendingSnapshotFileWork
      expect(keyed.runtime.state.workspaceSession).toStrictEqual(expected)
      expect(staged).toStrictEqual(stagedCopy)
      expect(prior).toStrictEqual(saved)
      const actual = sessionPublication(keyed.runtime.state).partition('local').index
      const rebuilt = new SessionUnitIndex(expected)
      for (const field of SESSION_MAP_FIELDS) {
        expect([...actual.keys(field)]).toEqual([...rebuilt.keys(field)])
        for (const key of rebuilt.keys(field)) {
          expect(actual.ids(field, key, 'scrollback')).toEqual(
            rebuilt.ids(field, key, 'scrollback')
          )
        }
      }
    }
  )
})
