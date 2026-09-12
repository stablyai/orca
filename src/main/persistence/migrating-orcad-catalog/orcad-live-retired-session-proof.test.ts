import { expect, it } from 'vitest'
import { liveSourceRetirementFixture } from './orcad-live-source-retirement-test-fixture'
import { collectOrcadLiveRetirementProfileChanges } from './orcad-live-retirement-profile-changes'
import {
  hasOrcadLiveRetiredSessionAfterState,
  hasOrcadLiveRetiredSourceSessionState
} from './orcad-live-retired-session-proof'

function fixture(mirrorLocal = true, kind: 'folder' | 'worktree' = 'folder') {
  const f = liveSourceRetirementFixture(kind, 'ssh-1', mirrorLocal)
  const before = structuredClone(f.state)
  const state = f.run()
  const record = {
    release: { cutover: f.cutover },
    changes: collectOrcadLiveRetirementProfileChanges(before, state)
  } as Parameters<typeof hasOrcadLiveRetiredSessionAfterState>[1]
  return {
    ...f,
    before,
    state,
    record,
    inspect: () => hasOrcadLiveRetiredSessionAfterState(state, record)
  }
}

it.each([true, false])(
  'accepts the freshly installed session without mutation (mirror=%s)',
  (mirror) => {
    const f = fixture(mirror)
    const before = structuredClone(f.state)
    expect(f.inspect()).toBe(true)
    expect(f.state).toEqual(before)
  }
)

it('allows unrelated session globals and map entries to evolve', () => {
  const f = fixture()
  f.state.workspaceSession.activeTabId = 'unrelated-tab'
  f.state.workspaceSession.lastVisitedAtByWorktreeId = { 'unrelated::/repo': 5 }
  f.state.workspaceSessionsByHostId![f.hostId]!.terminalLayoutsByTabId['unrelated-tab'] = {
    root: null,
    activeLeafId: null,
    expandedLeafId: null
  }
  expect(f.inspect()).toBe(true)
})

it.each(['activeRepoId', 'activeWorktreeId', 'activeWorkspaceKey'] as const)(
  'allows destination-owned %s with its retained source identity',
  (field) => {
    const f = fixture(true, 'worktree')
    const session = f.state.workspaceSession
    session.activeWorkspaceExecutionHostId = `runtime:${f.cutover.destinationEnvironmentId}`
    if (field === 'activeRepoId') {
      session.activeRepoId = f.cutover.manifest.payload.repositories[0].id
    } else if (field === 'activeWorkspaceKey') {
      session.activeWorkspaceKey = 'worktree:repo-1::/srv/worktree'
    } else {
      session.activeWorktreeId = 'repo-1::/srv/worktree'
    }
    expect(hasOrcadLiveRetiredSourceSessionState(f.state, f.record)).toBe(true)
  }
)

it.each(['activeRepoId', 'activeWorktreeId', 'activeWorkspaceKey'] as const)(
  'still refuses source-owned and unstamped %s references',
  (field) => {
    for (const host of ['ssh:ssh-1', 'runtime:other', undefined] as const) {
      const f = fixture(true, 'worktree')
      f.state.workspaceSession.activeWorkspaceExecutionHostId = host
      if (field === 'activeRepoId') {
        f.state.workspaceSession.activeRepoId = f.cutover.manifest.payload.repositories[0].id
      } else if (field === 'activeWorkspaceKey') {
        f.state.workspaceSession.activeWorkspaceKey = 'worktree:repo-1::/srv/worktree'
      } else {
        f.state.workspaceSession.activeWorktreeId = 'repo-1::/srv/worktree'
      }
      expect(hasOrcadLiveRetiredSourceSessionState(f.state, f.record)).toBe(false)
    }
  }
)

it('does not let destination selection conceal source-qualified workspace or terminal state', () => {
  const f = fixture(true, 'worktree')
  f.state.workspaceSession.activeWorkspaceExecutionHostId = `runtime:${f.cutover.destinationEnvironmentId}`
  f.state.workspaceSession.activeWorktreeId = 'ssh:ssh-1|repo-1::/srv/worktree'
  expect(hasOrcadLiveRetiredSourceSessionState(f.state, f.record)).toBe(false)
  f.state.workspaceSession.activeWorktreeId = null
  f.state.workspaceSession.tabsByWorktree = f.before.workspaceSession.tabsByWorktree
  expect(hasOrcadLiveRetiredSourceSessionState(f.state, f.record)).toBe(false)
})

it.each([
  'tab',
  'layout',
  'pane',
  'shutdown',
  'reconnect',
  'owner',
  'source-pty',
  'tab-reference',
  'incarnation'
])('refuses reappearing source %s without rewriting newer data', (kind) => {
  const f = fixture()
  const session = f.state.workspaceSession
  if (kind === 'tab') {
    const tab = structuredClone(Object.values(f.before.workspaceSession.tabsByWorktree)[0][0])
    session.tabsByWorktree['unrelated::/repo'] = [
      { ...tab, worktreeId: 'unrelated::/repo', ptyId: 'new-pty' }
    ]
  }
  if (kind === 'layout') {
    session.terminalLayoutsByTabId['tab-1'] = {
      root: null,
      activeLeafId: null,
      expandedLeafId: null
    }
  }
  if (kind === 'pane') {
    session.terminalPtyIncarnationsByPaneKey = { 'tab-1:new-leaf': 'new-incarnation' }
  }
  if (kind === 'incarnation') {
    session.terminalPtyIncarnationsByPaneKey = {
      'unrelated:new-leaf': f.cutover.liveTerminalBindings![0].identity.incarnationId
    }
  }
  if (kind === 'shutdown') {
    session.activeWorktreeIdsOnShutdown = ['folder:folder-1']
  }
  if (kind === 'reconnect') {
    session.activeConnectionIdsAtShutdown = ['ssh-1']
  }
  if (kind === 'owner') {
    session.lastVisitedAtByWorktreeId = { 'ssh:ssh-1|folder:folder-1': 10 }
  }
  if (kind === 'source-pty') {
    session.remoteSessionIdsByTabId = {
      relocated: Object.values(f.before.workspaceSession.tabsByWorktree)[0][0].ptyId!
    }
  }
  if (kind === 'tab-reference') {
    session.activeTabIdByWorktree = { unrelated: 'tab-1' }
  }
  const before = structuredClone(f.state)
  expect(f.inspect()).toBe(false)
  expect(f.state).toEqual(before)
})

it('allows explicit foreign owner collisions and a new destination partition', () => {
  const f = fixture()
  f.state.workspaceSession.lastVisitedAtByWorktreeId = { 'ssh:foreign|folder:folder-1': 3 }
  f.state.workspaceSessionsByHostId!['runtime:environment'] = structuredClone(
    f.before.workspaceSession
  )
  const destination = f.state.workspaceSessionsByHostId!['runtime:environment']!
  for (const tabs of Object.values(destination.tabsByWorktree)) {
    for (const tab of tabs) {
      tab.ptyId = 'destination-pty'
    }
  }
  for (const layout of Object.values(destination.terminalLayoutsByTabId)) {
    for (const leaf of Object.keys(layout.ptyIdsByLeafId ?? {})) {
      layout.ptyIdsByLeafId![leaf] = 'destination-pty'
    }
  }
  expect(f.inspect()).toBe(true)
})

it.each(['runtime:environment', 'ssh:foreign'] as const)(
  'refuses source PTY authority relocated to %s',
  (host) => {
    const f = fixture()
    f.state.workspaceSessionsByHostId![host] = structuredClone(f.before.workspaceSession)
    const before = structuredClone(f.state)
    expect(f.inspect()).toBe(false)
    expect(f.state).toEqual(before)
  }
)

it('does not confuse foreign history and title text with a source PTY reference', () => {
  const f = fixture()
  const ptyId = Object.values(f.before.workspaceSession.tabsByWorktree)[0][0].ptyId!
  const session = structuredClone(f.state.workspaceSession)
  session.browserUrlHistory = [
    {
      url: 'https://example.com',
      normalizedUrl: 'https://example.com',
      title: ptyId,
      lastVisitedAt: 1,
      visitCount: 1
    }
  ]
  f.state.workspaceSessionsByHostId!['runtime:environment'] = session
  const tab = structuredClone(Object.values(f.before.workspaceSession.tabsByWorktree)[0][0])
  f.state.workspaceSession.tabsByWorktree['unrelated::/repo'] = [
    {
      ...tab,
      id: 'unrelated-tab',
      worktreeId: 'unrelated::/repo',
      ptyId: 'unrelated-pty',
      title: ptyId
    }
  ]
  expect(f.inspect()).toBe(true)
})

it('fails closed on unknown fields and malformed known maps', () => {
  const f = fixture()
  Object.assign(f.state.workspaceSession, { futureOwnership: {} })
  expect(f.inspect()).toBe(false)
  delete (f.state.workspaceSession as unknown as Record<string, unknown>).futureOwnership
  Object.assign(f.state.workspaceSession, { tabsByWorktree: [] })
  expect(f.inspect()).toBe(false)
  Object.assign(f.state.workspaceSession, { tabsByWorktree: { unrelated: 'malformed' } })
  expect(f.inspect()).toBe(false)
})

it('retains exact changed evidence in a preexisting foreign partition', () => {
  const f = fixture()
  const change = f.record.changes.find((entry) => entry.field === 'workspaceSessionsByHostId')!
  const before = JSON.parse(change.before!)
  const after = JSON.parse(change.after!)
  before['runtime:environment'] = { ...f.state.workspaceSession, activeTabId: 'old' }
  after['runtime:environment'] = { ...f.state.workspaceSession, activeTabId: 'installed' }
  change.before = JSON.stringify(before)
  change.after = JSON.stringify(after)
  f.state.workspaceSessionsByHostId!['runtime:environment'] = after['runtime:environment']
  expect(f.inspect()).toBe(true)
  f.state.workspaceSessionsByHostId!['runtime:environment']!.activeTabId = 'newer'
  expect(f.inspect()).toBe(false)
})

it('does not relax non-session retirement evidence', () => {
  const f = fixture()
  f.state.repos = f.before.repos
  expect(f.inspect()).toBe(false)
})
