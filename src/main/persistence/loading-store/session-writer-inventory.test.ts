import { nativeAffectedOwners } from './session-dependency-native.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { SESSION_MAP_FIELDS } from '../../../shared/session-change-set'
import { SessionUnitIndex } from '../../../shared/session-unit-index'
import { SessionUnitReader } from '../../../shared/session-unit-reader'
import {
  addWorkspace,
  GIT_KEY,
  leaf
} from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { deleteOwnerKeyedSessionFields } from '../restoring-sessions/session-owner-fields'
import { removeWorkspaceSessionOwnerEverywhere } from '../restoring-sessions/session-owner-removal'
import { removeRepoFromWorkspaceSession } from '../../orca-profiles/profile-project-session-state'
import { pruneWorktreeStateForRepo } from '../tracking-repos/repo-worktree-pruning'
import { migrateWorktreeIdentity } from '../tracking-repos/worktree-identity-migration'
import {
  assignWorkspaceSessionPartition,
  advanceTerminalTopologyRevision,
  writeRestorableSession
} from '../terminal-topology/terminal-topology-membership'
import { planTerminalLeafMove } from '../terminal-topology/terminal-leaf-move'
import {
  applyPreparedOrcadMigrationWorkspaceSession,
  prepareOrcadMigrationWorkspaceSession
} from '../migrating-orcad-catalog/orcad-destination-workspace-session'
import { subtractOrcadMigrationScopeWorkspaceSession } from '../migrating-orcad-catalog/orcad-source-workspace-session-subtraction'
import { subtractOrcadMigrationClientState } from '../migrating-orcad-catalog/orcad-source-client-subtraction'
import { orcadMigrationCutoverFixture } from '../../ssh/orcad-migration-cutover-fixture'
import {
  publishSessionChanges,
  publishSessionReplacement,
  sessionPublication
} from './session-publication'
import { prepareSessionOperation, runSessionOperation } from './session-operation'
import { clearReplacedPaneBinding } from './replaced-pane-binding'
import { applyPtyBinding } from './pty-binding-session-update'

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      freeze(child)
    }
    Object.freeze(value)
  }
  return value
}
function initial() {
  const state = getDefaultPersistedState('/tmp/session-writer-inventory')
  addWorkspace(state.workspaceSession, GIT_KEY, [
    { id: 'group', tabs: [{ id: 'tab', leaves: [[leaf(1), 'pty']] }] }
  ])
  state.workspaceSession.terminalTopologyRevisionByRepoId = { 'repo-1': 4 }
  return state
}
function nativeRemoveOwner(root: WorkspaceSessionState): WorkspaceSessionState {
  const next = structuredClone(root)
  deleteOwnerKeyedSessionFields(next, GIT_KEY, new Set())
  next.activeWorktreeIdsOnShutdown = next.activeWorktreeIdsOnShutdown?.filter(
    (id) => id !== GIT_KEY
  )
  return next
}
function verify(
  state: PersistedState,
  expected: WorkspaceSessionState,
  prior: WorkspaceSessionState,
  saved: WorkspaceSessionState
) {
  expect(state.workspaceSession).toStrictEqual(expected)
  expect(prior).toStrictEqual(saved)
  const publication = sessionPublication(state)
  for (const event of publication.take('local')) {
    expect(event.owners).toEqual(nativeAffectedOwners(prior, state.workspaceSession))
  }
  const actual = publication.partition('local').index
  const rebuilt = new SessionUnitIndex(expected)
  for (const field of SESSION_MAP_FIELDS) {
    expect(Object.hasOwn(state.workspaceSession, field)).toBe(Object.hasOwn(expected, field))
    expect([...actual.keys(field)]).toEqual(Object.keys(expected[field] ?? {}))
    for (const key of rebuilt.keys(field)) {
      for (const kind of [
        'owner',
        'tab',
        'pane',
        'leaf',
        'pty',
        'repo',
        'file',
        'page',
        'browser',
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
afterEach(() => vi.restoreAllMocks())

describe('writer inventory native-root differential', () => {
  const cases: readonly {
    name: string
    run(state: PersistedState): void
    native(root: WorkspaceSessionState): WorkspaceSessionState
  }[] = [
    {
      name: 'owner removal and partition adapters',
      run: (state) => removeWorkspaceSessionOwnerEverywhere(state, GIT_KEY),
      native: nativeRemoveOwner
    },
    {
      name: 'repo removal and residue operations',
      run: (state) => {
        runSessionOperation(state, 'local', { type: 'removeRepo', repoId: 'repo-1' })
      },
      native: (root) => removeRepoFromWorkspaceSession(root, 'repo-1')
    },
    {
      name: 'worktree pruning',
      run: (state) => pruneWorktreeStateForRepo(state, 'repo-1', null, () => {}),
      native: nativeRemoveOwner
    },
    {
      name: 'authoritative PTY retirement',
      run: (state) => {
        runSessionOperation(state, 'local', {
          type: 'retirePty',
          owner: GIT_KEY,
          tabId: 'tab',
          leafId: leaf(1),
          ptyId: 'pty'
        })
      },
      native: (root) =>
        clearReplacedPaneBinding(root, {
          worktreeId: GIT_KEY,
          parentTabId: 'tab',
          leafId: leaf(1),
          ptyId: 'pty'
        })
    },
    {
      name: 'topology assignment/revision',
      run: (state) => {
        const { root, index } = sessionPublication(state).partition('local')
        const reader = new SessionUnitReader(root, index)
        reader.write('terminalTopologyRevisionByRepoId', 'repo-1', { present: true, value: 5 })
        assignWorkspaceSessionPartition(state, 'local', reader)
      },
      native: (root) => advanceTerminalTopologyRevision(root, GIT_KEY)
    },
    {
      name: 'explicit full ingress / load / import publication',
      run: (state) => {
        publishSessionReplacement(state, 'local', {
          ...state.workspaceSession,
          activeRepoId: 'repo-1'
        })
      },
      native: (root) => ({ ...root, activeRepoId: 'repo-1' })
    },
    {
      name: 'destination migration install',
      run: (state) =>
        applyPreparedOrcadMigrationWorkspaceSession(
          {
            incoming: state.workspaceSession,
            merged: { ...state.workspaceSession, activeRepoId: 'repo-1' }
          },
          state
        ),
      native: (root) => ({ ...root, activeRepoId: 'repo-1' })
    }
  ]
  it.each(cases)(
    '$name preserves frozen prior and matches complete native enumeration',
    ({ run, native }) => {
      const state = initial(),
        prior = freeze(state.workspaceSession),
        saved = structuredClone(prior)
      const expected = native(saved)
      run(state)
      verify(state, expected, prior, saved)
    }
  )

  it('binding update and failure rollback retain later edits and run explicit effects once', () => {
    const state = initial(),
      prior = freeze(state.workspaceSession),
      saved = structuredClone(prior)
    const args = {
      worktreeId: GIT_KEY,
      tabId: 'tab',
      leafId: leaf(1),
      ptyId: 'successor',
      incarnationId: 'inc'
    }
    const expected = applyPtyBinding(args, saved, GIT_KEY, `tab:${leaf(1)}`)
    const reader = prepareSessionOperation(
      prior,
      { type: 'bindPty', owner: GIT_KEY, paneKey: `tab:${leaf(1)}`, binding: args },
      sessionPublication(state).partition('local').index
    )
    const effects: string[] = []
    publishSessionChanges(
      state,
      'local',
      reader.prepare({ kind: 'authoritative', effects: [() => effects.push('published')] })
    )
    verify(state, expected, prior, saved)
    expect(effects).toEqual(['published'])
    const later = new SessionUnitReader(
      state.workspaceSession,
      sessionPublication(state).partition('local').index
    )
    later.write('tabsByWorktree', GIT_KEY, {
      present: true,
      value: state.workspaceSession.tabsByWorktree[GIT_KEY].map((tab) => ({
        ...tab,
        title: 'later'
      }))
    })
    publishSessionChanges(state, 'local', later.prepare({ kind: 'authoritative' }))
    runSessionOperation(state, 'local', {
      type: 'rollbackPty',
      staged: reader,
      binding: { owner: GIT_KEY, tabId: 'tab', leafId: leaf(1) }
    })
    expect(state.workspaceSession.tabsByWorktree[GIT_KEY][0].title).toBe('later')
    expect(prior).toStrictEqual(saved)
    expect(effects).toEqual(['published'])
  })

  it('host deletion is explicit and leaves the other host and materialized prior unchanged', () => {
    const state = initial(),
      remote = freeze(structuredClone(state.workspaceSession)),
      saved = structuredClone(remote)
    state.workspaceSessionsByHostId = { 'ssh:one': remote, 'ssh:two': remote }
    publishSessionReplacement(state, 'ssh:one', undefined)
    expect(Object.hasOwn(state.workspaceSessionsByHostId, 'ssh:one')).toBe(false)
    expect(state.workspaceSessionsByHostId['ssh:two']).toBe(remote)
    expect(remote).toStrictEqual(saved)
    expect([
      ...sessionPublication(state).partition('ssh:one').index.keys('tabsByWorktree')
    ]).toEqual([])
  })

  it('migration source subtraction owns copied revision values before deleting them', () => {
    const state = initial(),
      prior = freeze(state.workspaceSession),
      saved = structuredClone(prior)
    const manifest = orcadMigrationCutoverFixture('writer-inventory', 'source').manifest
    const repo = {
      id: 'repo-1',
      path: '/repo',
      displayName: 'Repo',
      badgeColor: '#737373',
      addedAt: 1,
      connectionId: 'source'
    }
    state.repos = [repo]
    manifest.payload.repositories = [repo]
    const expected = nativeRemoveOwner(saved)
    expected.terminalTopologyRevisionByRepoId = {}
    subtractOrcadMigrationScopeWorkspaceSession(state, manifest)
    verify(state, expected, prior, saved)
  })

  it('migration conflicts refuse before publication or effects', () => {
    const state = initial(),
      prior = freeze(state.workspaceSession),
      saved = structuredClone(prior)
    const conflicting = structuredClone(prior)
    conflicting.tabsByWorktree[GIT_KEY][0].title = 'conflict'
    expect(() => prepareOrcadMigrationWorkspaceSession(conflicting, state)).toThrow(
      'orcad_migration_dormant_id_conflict'
    )
    expect(state.workspaceSession).toBe(prior)
    expect(sessionPublication(state).partition('local').generation).toBe(0)
    expect(prior).toStrictEqual(saved)
  })

  it('leaf move preserves explicit field construction, prepared routing, time and leaf identity', () => {
    vi.spyOn(Date, 'now').mockReturnValue(123456)
    const state = initial(),
      prior = freeze(state.workspaceSession),
      saved = structuredClone(prior)
    const reader = new SessionUnitReader(prior, sessionPublication(state).partition('local').index)
    const request = {
      worktreeId: GIT_KEY,
      sourceTabId: 'tab',
      targetTabId: 'next',
      leafId: leaf(1),
      ptyId: 'pty'
    }
    const planned = planTerminalLeafMove(
      [{ hostId: 'local', session: prior, prepared: reader }],
      request
    )
    expect(planned.result).toStrictEqual({ status: 'moved', ptyId: 'pty' })
    expect(planned.sessions[0].prepared).toBe(reader)
    const next = planned.sessions[0].session
    expect(next.tabsByWorktree[GIT_KEY].at(-1)).toMatchObject({
      id: 'next',
      createdAt: 123456,
      ptyId: 'pty'
    })
    expect(next.terminalLayoutsByTabId.next.root).toStrictEqual({ type: 'leaf', leafId: leaf(1) })
    for (const field of [
      'terminalPtyIncarnationsByPaneKey',
      'sleepingAgentSessionsByPaneKey'
    ] as const) {
      expect(Object.hasOwn(next, field)).toBe(true)
      expect(next[field]).toBeUndefined()
    }
    expect(prior).toStrictEqual(saved)
    const refused = planTerminalLeafMove([{ hostId: 'local', session: prior }], {
      ...request,
      targetTabId: 'tab'
    })
    expect(refused.result).toStrictEqual({ status: 'refused', reason: 'target_tab_exists' })
    expect(refused.sessions).toEqual([])
  })

  it('topology inverse keeps successor title edits and retires only its own change', () => {
    const state = initial(),
      prior = freeze(state.workspaceSession),
      saved = structuredClone(prior)
    const reader = new SessionUnitReader(prior, sessionPublication(state).partition('local').index)
    reader.write('remoteSessionIdsByTabId', 'tab', { present: true, value: 'relay' })
    const dirty = vi.fn()
    const restore = writeRestorableSession(state, 'local', reader, dirty)
    const later = new SessionUnitReader(
      state.workspaceSession,
      sessionPublication(state).partition('local').index
    )
    later.write('tabsByWorktree', GIT_KEY, {
      present: true,
      value: state.workspaceSession.tabsByWorktree[GIT_KEY].map((tab) => ({
        ...tab,
        title: 'later'
      }))
    })
    publishSessionChanges(state, 'local', later.prepare({ kind: 'authoritative' }))
    restore()
    expect(state.workspaceSession.remoteSessionIdsByTabId?.tab).toBeUndefined()
    expect(state.workspaceSession.tabsByWorktree[GIT_KEY][0].title).toBe('later')
    expect(prior).toStrictEqual(saved)
    expect(dirty).toHaveBeenCalledTimes(2)
  })

  it('identity migration matches native owner rekeying across local and host partitions', () => {
    const state = initial(),
      nextOwner = 'repo-1::/new'
    state.workspaceSessionsByHostId = { 'ssh:one': structuredClone(state.workspaceSession) }
    const prior = freeze(state.workspaceSession),
      saved = structuredClone(prior)
    const remote = freeze(state.workspaceSessionsByHostId['ssh:one'])
    const expected = structuredClone(saved)
    expected.tabsByWorktree[nextOwner] = expected.tabsByWorktree[GIT_KEY].map((row) => ({
      ...row,
      worktreeId: nextOwner
    }))
    delete expected.tabsByWorktree[GIT_KEY]
    for (const field of ['unifiedTabs', 'tabGroups'] as const) {
      expected[field] = {
        [nextOwner]: expected[field]![GIT_KEY].map((row) => ({ ...row, worktreeId: nextOwner }))
      }
    }
    for (const field of [
      'activeTabIdByWorktree',
      'tabGroupLayouts',
      'activeGroupIdByWorktree'
    ] as const) {
      const value = expected[field]?.[GIT_KEY]
      Object.assign(expected, { [field]: { [nextOwner]: value } })
    }
    expect(migrateWorktreeIdentity(state, GIT_KEY, nextOwner)).toBe(true)
    verify(state, expected, prior, saved)
    expect(state.workspaceSessionsByHostId['ssh:one']).toStrictEqual(expected)
    expect(remote).toStrictEqual(saved)
    expect(migrateWorktreeIdentity(state, nextOwner, nextOwner)).toBe(false)
  })

  it('nested migration intents publish a complete native field and accept only exact retries', () => {
    const state = initial()
    const intent = { browserPageId: 'page', worktreeId: GIT_KEY, closedAt: 42 }
    state.workspaceSession.clientHostedBrowserCloseIntentsByEnvironment = { old: [intent] }
    const prior = freeze(state.workspaceSession),
      saved = structuredClone(prior)
    const manifest = orcadMigrationCutoverFixture('writer-intents', 'source', {
      environmentId: 'destination'
    }).manifest
    manifest.payload.dormantState = {
      version: 1,
      worktreeMeta: [],
      worktreeLineage: [],
      workspaceLineage: [],
      sparsePresets: [],
      retiredWorktreeNames: [],
      retiredWorktreeNamespaces: [],
      clientState: { clientHostedBrowserCloseIntents: [{ sourceEnvironmentId: 'old', ...intent }] }
    }
    const expected = {
      ...saved,
      clientHostedBrowserCloseIntentsByEnvironment: { destination: [intent] }
    }
    subtractOrcadMigrationClientState(state, manifest)
    verify(state, expected, prior, saved)
    subtractOrcadMigrationClientState(state, manifest)
    verify(state, expected, prior, saved)
  })

  it('leaf move retains an explicitly empty field when the last stale incarnation is retired', () => {
    vi.spyOn(Date, 'now').mockReturnValue(123456)
    const live = initial().workspaceSession,
      stale = structuredClone(live)
    stale.terminalLayoutsByTabId.tab.ptyIdsByLeafId = { [leaf(1)]: 'stale' }
    stale.terminalPtyIncarnationsByPaneKey = { [`tab:${leaf(1)}`]: 'old' }
    const prior = freeze(stale),
      saved = structuredClone(prior)
    const planned = planTerminalLeafMove(
      [
        { hostId: 'local', session: freeze(live) },
        { hostId: 'ssh:one', session: prior }
      ],
      {
        worktreeId: GIT_KEY,
        sourceTabId: 'tab',
        targetTabId: 'next',
        leafId: leaf(1),
        ptyId: 'pty'
      }
    )
    expect(planned.result).toStrictEqual({ status: 'moved', ptyId: 'pty' })
    const next = planned.sessions.find((entry) => entry.hostId === 'ssh:one')!.session
    const expected = { ...saved.terminalPtyIncarnationsByPaneKey }
    delete expected[`tab:${leaf(1)}`]
    expect(Object.hasOwn(next, 'terminalPtyIncarnationsByPaneKey')).toBe(true)
    expect(next.terminalPtyIncarnationsByPaneKey).toStrictEqual(expected)
    expect(prior).toStrictEqual(saved)
  })
})
