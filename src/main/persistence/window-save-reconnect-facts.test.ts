import {
  type SessionEntry,
  type SessionPresence,
  SessionUnitReader,
  selectSessionUnits
} from '../../shared/session-unit-reader'

import type { SessionMapField } from '../../shared/session-change-set'

import { sessionPublication, publishSessionChanges } from './loading-store/session-publication'
import {
  deriveIndexedShutdownReconnectFacts,
  invalidateShutdownReconnectPty
} from '../runtime/terminal/recovery/shutdown-reconnect-fact-index'
import {
  type ReconnectFactSources,
  deriveShutdownReconnectFacts
} from '../runtime/terminal/recovery/shutdown-reconnect-facts'
import { describe, expect, it, vi } from 'vitest'
import { toSshExecutionHostId } from '../../shared/execution-host'
import type { SshConnectionStatus } from '../../shared/ssh-types'
import {
  addWorkspace,
  emptySession,
  GIT_KEY,
  leaf,
  SSH_KEY
} from '../../shared/workspace-layout/workspace-layout-session.test-fixture'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

import { windowViewPatchForMain, windowViewSaveForMain } from './window-save-view'

const TARGET = 'target'
const SSH_HOST = toSshExecutionHostId(TARGET)
const RELAY = `ssh:${TARGET}@@pty-42`

function sshPartition(): WorkspaceSessionState {
  return addWorkspace(
    emptySession(),
    SSH_KEY,
    [{ id: 'group-s', tabs: [{ id: 'tab-s', leaves: [[leaf(3), RELAY]] }] }],
    SSH_HOST
  )
}

function localPartition(): WorkspaceSessionState {
  return addWorkspace(emptySession(), GIT_KEY, [
    {
      id: 'group-g',
      tabs: [
        { id: 'tab-live', leaves: [[leaf(1), 'pty-live']] },
        { id: 'tab-gone', leaves: [[leaf(2), 'pty-gone']] }
      ]
    }
  ])
}

const factsFor =
  (
    live: string[],
    ssh: [string, SshConnectionStatus][],
    more: { exited?: string[]; others?: WorkspaceSessionState[] } = {}
  ) =>
  (session: WorkspaceSessionState) =>
    deriveShutdownReconnectFacts(session, {
      isLiveLocalPty: (ptyId) => live.includes(ptyId),
      isKnownExited: (ptyId) => more.exited?.includes(ptyId) ?? false,
      sshStatusByTargetId: new Map(ssh),
      otherPartitions: () => more.others ?? []
    })

function forgetfulSave(stored: WorkspaceSessionState): WorkspaceSessionState {
  return {
    ...stored,
    activeWorktreeIdsOnShutdown: [],
    remoteSessionIdsByTabId: undefined,
    activeConnectionIdsAtShutdown: undefined
  }
}

describe('what the next startup reconnects comes from main, not the window’s save', () => {
  it('keeps an unvisited SSH tab’s relay session and its target the window dropped', () => {
    const stored = sshPartition()

    const saved = windowViewSaveForMain(
      stored,
      forgetfulSave(stored),
      SSH_HOST,
      factsFor([], [[TARGET, 'reconnecting']])
    )

    expect(saved.remoteSessionIdsByTabId).toEqual({ 'tab-s': RELAY })
    expect(saved.activeWorktreeIdsOnShutdown).toEqual([SSH_KEY])
    expect(saved.activeConnectionIdsAtShutdown).toEqual([TARGET])
  })

  it('names only workspaces with a running local terminal, whatever the window sent', () => {
    const stored = localPartition()
    const save = { ...stored, activeWorktreeIdsOnShutdown: ['repo-1::/elsewhere'] }

    const saved = windowViewSaveForMain(stored, save, null, factsFor(['pty-live'], []))

    expect(saved.activeWorktreeIdsOnShutdown).toEqual([GIT_KEY])
    expect(saved).not.toHaveProperty('remoteSessionIdsByTabId')
    expect(saved).not.toHaveProperty('activeConnectionIdsAtShutdown')
    expect(
      windowViewSaveForMain(stored, save, null, factsFor([], [])).activeWorktreeIdsOnShutdown
    ).toEqual([])
  })

  it('a slept pane keeps its relay id as a wake hint only: the next startup does not reconnect it', () => {
    const stored = sshPartition()
    stored.sleepingAgentSessionsByPaneKey = {
      [`tab-s:${leaf(3)}`]: {
        paneKey: `tab-s:${leaf(3)}`,
        worktreeId: SSH_KEY,
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'sess-1' },
        prompt: '',
        state: 'working',
        capturedAt: 1,
        updatedAt: 1,
        origin: 'worktree-sleep'
      }
    }

    const saved = windowViewSaveForMain(stored, stored, SSH_HOST, factsFor([], []))

    expect(saved).not.toHaveProperty('remoteSessionIdsByTabId')
    expect(saved.activeWorktreeIdsOnShutdown).toEqual([])
  })

  it.each(['live', 'quit'] as const)(
    'a running agent’s %s resume record is not a sleep: its relay session reconnects',
    (origin) => {
      const stored = sshPartition()
      stored.sleepingAgentSessionsByPaneKey = {
        [`tab-s:${leaf(3)}`]: {
          paneKey: `tab-s:${leaf(3)}`,
          worktreeId: SSH_KEY,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'sess-1' },
          prompt: '',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin
        }
      }

      const saved = windowViewSaveForMain(stored, stored, SSH_HOST, factsFor([], []))

      expect(saved.remoteSessionIdsByTabId).toEqual({ 'tab-s': RELAY })
      expect(saved.activeWorktreeIdsOnShutdown).toEqual([SSH_KEY])
    }
  )

  it('a target the user left offline is not redialed; a connected one is', () => {
    const stored = sshPartition()

    expect(
      windowViewSaveForMain(stored, stored, SSH_HOST, factsFor([], [[TARGET, 'disconnected']]))
    ).not.toHaveProperty('activeConnectionIdsAtShutdown')
    expect(
      windowViewSaveForMain(stored, stored, SSH_HOST, factsFor([], [['other', 'connected']]))
        .activeConnectionIdsAtShutdown
    ).toEqual(['other'])
  })

  it('the local save names a target in a passing state from a relay session in its SSH partition', () => {
    const local = localPartition()
    // Reconnecting relay routes remain recoverable at quit.
    const facts = factsFor([], [[TARGET, 'reconnecting']], { others: [sshPartition()] })

    expect(windowViewSaveForMain(local, local, null, facts).activeConnectionIdsAtShutdown).toEqual([
      TARGET
    ])
  })

  it('a relay session proven exited (a slept plain shell) is not reconnected', () => {
    const stored = sshPartition()

    const saved = windowViewSaveForMain(
      stored,
      stored,
      SSH_HOST,
      factsFor([], [[TARGET, 'reconnecting']], { exited: [RELAY] })
    )

    expect(saved).not.toHaveProperty('remoteSessionIdsByTabId')
    expect(saved.activeWorktreeIdsOnShutdown).toEqual([])
    expect(saved).not.toHaveProperty('activeConnectionIdsAtShutdown')
  })

  it('a patch has main’s facts only for the fields it carries', () => {
    const stored = sshPartition()
    const facts = factsFor([], [[TARGET, 'connected']])

    expect(
      windowViewPatchForMain(stored, { activeConnectionIdsAtShutdown: [] }, SSH_HOST, facts)
    ).toEqual({ activeConnectionIdsAtShutdown: [TARGET] })
    expect(windowViewPatchForMain(stored, { activeRepoId: 'r' }, SSH_HOST, facts)).toEqual({
      activeRepoId: 'r'
    })
  })
})

describe('indexed reconnect contributions match full enumeration', () => {
  it('retains other owners on membership-only patches and refreshes live, exit and SSH facts', () => {
    const state = {
      workspaceSession: localPartition(),
      workspaceSessionsByHostId: { [SSH_HOST]: sshPartition() }
    }
    const publication = sessionPublication(state)
    const live = new Set(['pty-live']),
      exited = new Set<string>(),
      factOwner = {}
    const status = new Map<string, SshConnectionStatus>([[TARGET, 'reconnecting']])
    const calls: string[] = []
    const sources: ReconnectFactSources = {
      factOwner,
      isLiveLocalPty: (pty) => {
        calls.push(pty)
        return live.has(pty)
      },
      isKnownExited: (pty) => exited.has(pty),
      sshStatusByTargetId: status,
      otherPartitions: () => [state.workspaceSessionsByHostId[SSH_HOST]]
    }
    const compare = (
      edit?: (reader: SessionUnitReader) => void,
      native?: (root: WorkspaceSessionState) => WorkspaceSessionState
    ) => {
      const { root, index } = publication.partition('local')
      const reader = new SessionUnitReader(root, index)
      edit?.(reader)
      const actual = deriveIndexedShutdownReconnectFacts(
        reader,
        selectSessionUnits(reader),
        sources
      )
      const full = deriveShutdownReconnectFacts(native ? native(root) : root, sources)
      expect(actual).toStrictEqual(full)
      expect(Object.keys(actual.remoteSessionIdsByTabId ?? {})).toEqual(
        Object.keys(full.remoteSessionIdsByTabId ?? {})
      )
      publishSessionChanges(state, 'local', reader.prepare({ kind: 'renderer' }))
      return actual
    }
    expect(compare().activeWorktreeIdsOnShutdown).toEqual([GIT_KEY])
    calls.length = 0
    const untouched = publication.partition('local')
    const membershipOnly = new SessionUnitReader(untouched.root, untouched.index)
    membershipOnly.replace('activeWorktreeIdsOnShutdown', { present: true, value: [] })
    deriveIndexedShutdownReconnectFacts(membershipOnly, selectSessionUnits(membershipOnly), sources)
    expect(calls).toEqual([])
    compare(
      (reader) => reader.replace('activeWorktreeIdsOnShutdown', { present: true, value: [] }),
      (root) => ({ ...root, activeWorktreeIdsOnShutdown: [] })
    )
    live.delete('pty-live')
    invalidateShutdownReconnectPty(factOwner, 'pty-live')
    expect(compare().activeWorktreeIdsOnShutdown).toEqual([])
    exited.add(RELAY)
    invalidateShutdownReconnectPty(factOwner, RELAY)
    expect(compare().activeConnectionIdsAtShutdown).toBeUndefined()
    status.set(TARGET, 'connected')
    expect(compare().activeConnectionIdsAtShutdown).toEqual([TARGET])
    status.set(TARGET, 'disconnected')
    expect(compare().activeConnectionIdsAtShutdown).toBeUndefined()
  })

  it('preserves first successful tab order, last duplicate value and frozen prior roots', () => {
    const first = 'ssh:a@@first',
      last = 'ssh:b@@last',
      integer = 'ssh:c@@integer'
    const row = (id: string, owner: string, ptyId: string) => ({
      id,
      worktreeId: owner,
      ptyId,
      title: id,
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    })
    const session: WorkspaceSessionState = {
      ...emptySession(),
      tabsByWorktree: {
        '2': [row('duplicate', '2', last)],
        other: [row('later', 'other', first)]
      },
      terminalLayoutsByTabId: {}
    }
    const freeze = (value: unknown): void => {
      if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) {
          freeze(child)
        }
        Object.freeze(value)
      }
    }
    freeze(session)
    const state = { workspaceSession: session }
    const publication = sessionPublication(state)
    const sources: ReconnectFactSources = {
      factOwner: {},
      isLiveLocalPty: () => false,
      isKnownExited: () => false,
      sshStatusByTargetId: new Map([
        ['a', 'reconnecting'],
        ['b', 'reconnecting'],
        ['c', 'reconnecting']
      ])
    }
    const additions = [row('duplicate', '1', integer), row('1', '1', integer)]
    const replacement = {
      other: session.tabsByWorktree.other,
      '2': session.tabsByWorktree['2'],
      added: [row('last', 'added', last)]
    }
    const edits = [
      { edit: (_reader: SessionUnitReader) => {}, native: (root: WorkspaceSessionState) => root },
      {
        edit: (reader: SessionUnitReader) =>
          reader.write('tabsByWorktree', '1', { present: true, value: additions }),
        native: (root: WorkspaceSessionState) => ({
          ...root,
          tabsByWorktree: { ...root.tabsByWorktree, '1': additions }
        })
      },
      {
        edit: (reader: SessionUnitReader) =>
          reader.replace('tabsByWorktree', { present: true, value: replacement }),
        native: (root: WorkspaceSessionState) => ({ ...root, tabsByWorktree: replacement })
      },
      {
        edit: (reader: SessionUnitReader) =>
          reader.replace('tabsByWorktree', { present: true, value: {} }),
        native: (root: WorkspaceSessionState) => ({ ...root, tabsByWorktree: {} })
      }
    ]
    for (const { edit, native } of edits) {
      const { root, index } = publication.partition('local')
      freeze(root)
      const saved = structuredClone(root)
      const reader = new SessionUnitReader(root, index)
      edit(reader)
      const actual = deriveIndexedShutdownReconnectFacts(
        reader,
        selectSessionUnits(reader),
        sources
      )
      const full = deriveShutdownReconnectFacts(native(root), sources)
      expect(actual).toStrictEqual(full)
      expect(Object.keys(actual.remoteSessionIdsByTabId ?? {})).toEqual(
        Object.keys(full.remoteSessionIdsByTabId ?? {})
      )
      expect(root).toStrictEqual(saved)
      publishSessionChanges(state, 'local', reader.prepare({ kind: 'renderer' }))
    }
  })
})

describe('reconnect dependency transitions', () => {
  it('matches independent native candidates for pane bindings, sleep origins, tree order and removals', () => {
    const initial = sshPartition()
    const state = { workspaceSession: initial }
    const publication = sessionPublication(state)
    let model = initial
    const sources: ReconnectFactSources = {
      factOwner: {},
      isLiveLocalPty: () => false,
      isKnownExited: () => false,
      sshStatusByTargetId: new Map([
        [TARGET, 'reconnecting'],
        ['other', 'reconnecting']
      ])
    }
    const compare = <F extends SessionMapField>(
      field: F,
      key: string,
      entry: SessionPresence<SessionEntry<F>>
    ) => {
      const { root, index } = publication.partition('local')
      const saved = structuredClone(root)
      const reader = new SessionUnitReader(root, index)
      reader.write(field, key, entry)
      const map: Record<string, unknown> = { ...model[field] }
      if (entry.present) {
        Object.assign(map, { [key]: entry.value })
      } else {
        Reflect.deleteProperty(map, key)
      }
      model = { ...model, [field]: map }
      if (field === 'sleepingAgentSessionsByPaneKey' && !Object.keys(map).length) {
        Reflect.deleteProperty(model, field)
      }
      const expected = deriveShutdownReconnectFacts(model, sources)
      expect(
        deriveIndexedShutdownReconnectFacts(reader, selectSessionUnits(reader), sources)
      ).toStrictEqual(expected)
      expect(root).toStrictEqual(saved)
      publishSessionChanges(state, 'local', reader.prepare({ kind: 'authoritative' }))
      expect(state.workspaceSession).toStrictEqual(model)
      const published = publication.partition('local')
      const fresh = new SessionUnitReader(published.root, published.index)
      expect(deriveIndexedShutdownReconnectFacts(fresh, fresh.selection(), sources)).toStrictEqual(
        expected
      )
    }
    const paneKey = `tab-s:${leaf(3)}`
    const sleeping = {
      paneKey,
      worktreeId: SSH_KEY,
      agent: 'codex' as const,
      providerSession: { key: 'session_id' as const, id: 'sess' },
      prompt: '',
      state: 'working' as const,
      capturedAt: 1,
      updatedAt: 1,
      origin: 'worktree-sleep' as const
    }
    compare('sleepingAgentSessionsByPaneKey', paneKey, { present: true, value: sleeping })
    compare('sleepingAgentSessionsByPaneKey', paneKey, {
      present: true,
      value: { ...sleeping, origin: 'live' }
    })
    compare('sleepingAgentSessionsByPaneKey', paneKey, { present: false, value: undefined })
    const layout = initial.terminalLayoutsByTabId['tab-s']
    compare('terminalLayoutsByTabId', 'tab-s', {
      present: true,
      value: {
        ...layout,
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: leaf(4) },
          second: { type: 'leaf', leafId: leaf(3) }
        },
        ptyIdsByLeafId: { [leaf(3)]: RELAY, [leaf(4)]: 'ssh:other@@next' }
      }
    })
    compare('tabsByWorktree', SSH_KEY, {
      present: true,
      value: initial.tabsByWorktree[SSH_KEY].map((tab) => ({ ...tab, ptyId: null }))
    })
    compare('terminalLayoutsByTabId', 'tab-s', {
      present: true,
      value: { ...layout, ptyIdsByLeafId: {} }
    })
    compare('tabsByWorktree', SSH_KEY, { present: false, value: undefined })
  })
})

it('refreshes only sealed affected reconnect owners, retaining genuine order and full invalidation', () => {
  const root = emptySession()
  for (let i = 0; i < 50; i++) {
    addWorkspace(root, `repo::/${i}`, [
      {
        id: `group-${i}`,
        tabs: [
          {
            id: `tab-${i}`,
            leaves: [[`${i.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`, `pty-${i}`]]
          }
        ]
      }
    ])
  }
  root.terminalTopologyRevisionByRepoId = {}
  const state = { workspaceSession: root },
    publication = sessionPublication(state)
  const calls: string[] = []
  const sources: ReconnectFactSources = {
    factOwner: {},
    isLiveLocalPty: (pty) => {
      calls.push(pty)
      return true
    },
    isKnownExited: () => false,
    sshStatusByTargetId: new Map()
  }
  const derive = () => {
    const { root: current, index } = publication.partition('local')
    const reader = new SessionUnitReader(current, index)
    return deriveIndexedShutdownReconnectFacts(reader, reader.selection(), sources)
  }
  derive()
  calls.length = 0
  const { index } = publication.partition('local')
  const keys = vi.spyOn(index, 'keys')
  try {
    const reader = new SessionUnitReader(root, index)
    reader.write('tabsByWorktree', 'repo::/0', {
      present: true,
      value: root.tabsByWorktree['repo::/0'].map((row) => ({ ...row, title: 'later' }))
    })
    reader.reconcileField('terminalTopologyRevisionByRepoId', {
      kind: 'output',
      present: true,
      explicitEmpty: true
    })
    publishSessionChanges(state, 'local', reader.prepare({ kind: 'renderer' }))
    derive()
    expect(calls).toEqual(['pty-0'])
    expect(keys).not.toHaveBeenCalled()
    calls.length = 0
    const reorder = new SessionUnitReader(state.workspaceSession, index)
    reorder.replace('tabsByWorktree', {
      present: true,
      value: Object.fromEntries(Object.entries(state.workspaceSession.tabsByWorktree).toReversed())
    })
    const prepared = reorder.prepare({ kind: 'authoritative' })
    expect(prepared.orders.has('tabsByWorktree')).toBe(true)
    publishSessionChanges(state, 'local', prepared)
    const actual = derive()
    expect(keys).toHaveBeenCalledWith('tabsByWorktree')
    expect(calls).toHaveLength(50)
    expect(actual).toStrictEqual(deriveShutdownReconnectFacts(state.workspaceSession, sources))
    calls.length = 0
    keys.mockClear()
    const full = new SessionUnitReader(state.workspaceSession, index)
    publishSessionChanges(
      state,
      'local',
      full.prepare({ kind: 'fullReplacement', fullReplacement: true })
    )
    derive()
    expect(keys).toHaveBeenCalledWith('tabsByWorktree')
    expect(calls).toHaveLength(50)
  } finally {
    keys.mockRestore()
  }
})

it('does not reset reconnect contributions for an empty tabs presence transition', () => {
  const root = emptySession()
  Object.assign(root, { tabsByWorktree: undefined })
  const state = { workspaceSession: root },
    publication = sessionPublication(state)
  const { index } = publication.partition('local')
  const sources: ReconnectFactSources = {
    factOwner: {},
    isLiveLocalPty: () => false,
    isKnownExited: () => false,
    sshStatusByTargetId: new Map()
  }
  const first = new SessionUnitReader(root, index)
  deriveIndexedShutdownReconnectFacts(first, first.selection(), sources)
  const reader = new SessionUnitReader(root, index)
  reader.replace('tabsByWorktree', { present: true, value: {} })
  const prepared = reader.prepare({ kind: 'renderer' })
  expect(prepared.orders.has('tabsByWorktree')).toBe(false)
  expect(prepared.units.some((unit) => unit.field === 'tabsByWorktree' && unit.key === null)).toBe(
    true
  )
  publishSessionChanges(state, 'local', prepared)
  const keys = vi.spyOn(index, 'keys')
  try {
    const next = new SessionUnitReader(state.workspaceSession, index)
    deriveIndexedShutdownReconnectFacts(next, next.selection(), sources)
    expect(keys).not.toHaveBeenCalled()
  } finally {
    keys.mockRestore()
  }
})
