import { expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  inspectReservedPtyOwnershipTransferLayoutAdmission as inspect,
  type ReservedPtyOwnershipTransferLayout
} from './pty-ownership-transfer-reserved-layout-admission'

const leaves = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
function fixture(owner = 'folder:destination') {
  const reservation: ReservedPtyOwnershipTransferLayout = {
    worktreeId: owner,
    tab: {
      id: 'tab',
      worktreeId: owner,
      ptyId: null,
      title: 'Saved title',
      customTitle: null,
      color: null,
      sortOrder: 4,
      createdAt: 123,
      isPinned: true
    },
    layout: {
      root: {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.3,
        first: { type: 'leaf', leafId: leaves[0]! },
        second: { type: 'leaf', leafId: leaves[1]! }
      },
      activeLeafId: leaves[1]!,
      expandedLeafId: null,
      titlesByLeafId: { [leaves[0]!]: 'Pane title' }
    },
    bindings: leaves.map((leafId, i) => ({
      worktreeId: owner,
      tabId: 'tab',
      leafId,
      ptyId: `pty-${i}`,
      incarnationId: `inc-${i}`
    }))
  }
  const session: WorkspaceSessionState = {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {}
  }
  const publish = (index: number) => {
    session.tabsByWorktree[owner] ??= [structuredClone(reservation.tab)]
    const layout = (session.terminalLayoutsByTabId.tab ??= structuredClone(reservation.layout))
    const binding = reservation.bindings[index]!
    ;(layout.ptyIdsByLeafId ??= {})[binding.leafId] = binding.ptyId
    ;(layout.scrollbackRefsByLeafId ??= {})[binding.leafId] = `v1-${'a'.repeat(32)}`
    ;(session.terminalPtyIncarnationsByPaneKey ??= {})[`tab:${binding.leafId}`] =
      binding.incarnationId!
    if (index === 0) {
      session.tabsByWorktree[owner]![0]!.ptyId = binding.ptyId
    }
  }
  return { reservation, session, publish }
}

it.each(['folder:destination', 'repo:worktree'])(
  'admits vacancy and both publication orders for %s',
  (owner) => {
    for (const order of [
      [0, 1],
      [1, 0]
    ]) {
      const { session, reservation, publish } = fixture(owner)
      for (const index of order) {
        const before = structuredClone(session)
        expect(inspect(session, reservation.bindings[index]!, reservation)).toBe('absent')
        expect(session).toEqual(before)
        publish(index)
        expect(inspect(session, reservation.bindings[index]!, reservation)).toBe('published')
      }
      const reloaded = JSON.parse(JSON.stringify(session)) as WorkspaceSessionState
      expect(inspect(reloaded, reservation.bindings[0]!, reservation)).toBe('published')
      expect(reloaded.terminalLayoutsByTabId.tab?.root).toEqual(reservation.layout.root)
    }
  }
)

it.each([
  [
    'title',
    (f: ReturnType<typeof fixture>) => {
      f.session.tabsByWorktree[f.reservation.worktreeId]![0]!.title = 'Changed'
    }
  ],
  [
    'ratio',
    (f: ReturnType<typeof fixture>) => {
      const root = f.session.terminalLayoutsByTabId.tab!.root!
      if (root.type === 'split') {
        root.ratio = 0.7
      }
    }
  ],
  [
    'inline bytes',
    (f: ReturnType<typeof fixture>) => {
      f.session.terminalLayoutsByTabId.tab!.buffersByLeafId = { [leaves[0]!]: 'other' }
    }
  ],
  [
    'primary identity',
    (f: ReturnType<typeof fixture>) => {
      f.session.tabsByWorktree[f.reservation.worktreeId]![0]!.ptyId = 'pty-1'
    }
  ],
  [
    'incarnation',
    (f: ReturnType<typeof fixture>) => {
      f.session.terminalPtyIncarnationsByPaneKey![`tab:${leaves[0]}`] = 'other'
    }
  ],
  [
    'extra binding',
    (f: ReturnType<typeof fixture>) => {
      f.session.terminalLayoutsByTabId.tab!.ptyIdsByLeafId!.extra = 'other'
    }
  ],
  [
    'foreign owner',
    (f: ReturnType<typeof fixture>) => {
      f.session.tabsByWorktree.other = [structuredClone(f.reservation.tab)]
    }
  ],
  [
    'global identity',
    (f: ReturnType<typeof fixture>) => {
      f.session.terminalPtyIncarnationsByPaneKey!['other:leaf'] = 'inc-1'
    }
  ]
] as const)('rejects %s without mutation', (_label, mutate) => {
  const f = fixture()
  f.publish(0)
  mutate(f)
  const before = structuredClone(f.session)
  expect(inspect(f.session, f.reservation.bindings[1]!, f.reservation)).toBe('conflict')
  expect(f.session).toEqual(before)
})

it('rejects duplicate reservation identities and requests outside the reservation', () => {
  const { session, reservation } = fixture()
  expect(inspect(session, { ...reservation.bindings[0]!, ptyId: 'other' }, reservation)).toBe(
    'conflict'
  )
  reservation.bindings = [reservation.bindings[0]!, reservation.bindings[0]!]
  expect(inspect(session, reservation.bindings[0]!, reservation)).toBe('conflict')
})

it('refuses retired tabs and surfaces even when their sessions are vacant', () => {
  const { session, reservation } = fixture()
  const binding = reservation.bindings[0]!
  session.closedTerminalTabTombstonesByTabId = {
    tab: { closedAt: 1, worktreeId: reservation.worktreeId }
  }
  expect(inspect(session, binding, reservation)).toBe('conflict')
  delete session.closedTerminalTabTombstonesByTabId
  session.terminalSurfaceTombstonesByPaneKey = {
    [`tab:${binding.leafId}`]: {
      worktreeId: binding.worktreeId,
      parentTabId: binding.tabId,
      leafId: binding.leafId,
      ptyId: binding.ptyId,
      incarnationId: binding.incarnationId!,
      retiredAt: 1
    }
  }
  expect(inspect(session, binding, reservation)).toBe('conflict')
})

it('preserves dormant snapshot references while allowing published snapshot overlays', () => {
  const f = fixture()
  f.reservation.layout.scrollbackRefsByLeafId = { [leaves[1]!]: `v1-${'b'.repeat(32)}` }
  f.publish(0)
  expect(inspect(f.session, f.reservation.bindings[1]!, f.reservation)).toBe('absent')
  delete f.session.terminalLayoutsByTabId.tab!.scrollbackRefsByLeafId![leaves[1]!]
  expect(inspect(f.session, f.reservation.bindings[1]!, f.reservation)).toBe('conflict')
})

function mixedFixture() {
  const f = fixture()
  const publishSecond = () => f.publish(0)
  f.reservation.bindings = [f.reservation.bindings[1]!]
  f.reservation.layout.scrollbackRefsByLeafId = { [leaves[0]!]: `v1-${'b'.repeat(32)}` }
  return {
    ...f,
    publishSecond: () => {
      publishSecond()
      f.session.tabsByWorktree[f.reservation.worktreeId]![0]!.ptyId = null
    }
  }
}

it('publishes only the second leaf while preserving its dormant first sibling and null primary', () => {
  const f = mixedFixture()
  const binding = f.reservation.bindings[0]!
  expect(inspect(f.session, binding, f.reservation)).toBe('absent')
  f.publishSecond()
  const before = structuredClone(f.session)
  expect(inspect(f.session, binding, f.reservation)).toBe('published')
  expect(f.session).toEqual(before)
  expect(f.session.terminalLayoutsByTabId.tab?.scrollbackRefsByLeafId?.[leaves[0]!]).toBe(
    `v1-${'b'.repeat(32)}`
  )
})

it.each(['title', 'snapshot', 'pty', 'incarnation'])('rejects dormant sibling %s drift', (kind) => {
  const f = mixedFixture()
  f.publishSecond()
  const layout = f.session.terminalLayoutsByTabId.tab!
  if (kind === 'title') {
    layout.titlesByLeafId![leaves[0]!] = 'Changed'
  }
  if (kind === 'snapshot') {
    layout.scrollbackRefsByLeafId![leaves[0]!] = `v1-${'c'.repeat(32)}`
  }
  if (kind === 'pty') {
    layout.ptyIdsByLeafId![leaves[0]!] = 'unexpected'
  }
  if (kind === 'incarnation') {
    f.session.terminalPtyIncarnationsByPaneKey![`tab:${leaves[0]}`] = 'unexpected'
  }
  expect(inspect(f.session, f.reservation.bindings[0]!, f.reservation)).toBe('conflict')
})

it.each(['topology', 'metadata', 'incarnation'])(
  'rejects global dormant leaf collision via %s',
  (kind) => {
    const f = mixedFixture()
    if (kind === 'incarnation') {
      f.session.terminalPtyIncarnationsByPaneKey = { [`other:${leaves[0]}`]: 'outside' }
    } else {
      f.session.terminalLayoutsByTabId.other = {
        root: kind === 'topology' ? { type: 'leaf', leafId: leaves[0]! } : null,
        activeLeafId: null,
        expandedLeafId: null,
        ...(kind === 'metadata' ? { titlesByLeafId: { [leaves[0]!]: 'Outside' } } : {})
      }
    }
    expect(inspect(f.session, f.reservation.bindings[0]!, f.reservation)).toBe('conflict')
  }
)
