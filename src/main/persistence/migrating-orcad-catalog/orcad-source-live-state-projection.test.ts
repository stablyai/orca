import { expect, it } from 'vitest'
import { toAppSshPtyId } from '../../../shared/ssh-pty-id'
import { createOrcadMigrationSourceScope } from './orcad-source-scope'
import { projectOrcadSourceLiveState } from './orcad-source-live-state-projection'
import { collectOrcadMigrationSourceWorkspaceSession } from './orcad-source-workspace-session'
import { terminalLayoutAdmissionFixture } from './orcad-terminal-layout-admission-test-fixture'

function fixture(kind: 'folder' | 'worktree' = 'folder') {
  const f = terminalLayoutAdmissionFixture(kind)
  const scope = createOrcadMigrationSourceScope({
    source: f.manifest.source,
    catalog: f.manifest.payload
  })
  const host = structuredClone(f.manifest.payload.dormantState!.workspaceSession!)
  const bindings = f.bindings.map((binding) => ({
    ...binding,
    identity: { ...binding.identity, ownerLease: 'owner' }
  }))
  host.terminalPtyIncarnationsByPaneKey = {}
  host.terminalLayoutsByTabId['tab-1'].ptyIdsByLeafId = {}
  for (const { identity, surfaceBinding } of bindings) {
    host.terminalLayoutsByTabId['tab-1'].ptyIdsByLeafId[surfaceBinding.leafId] = toAppSshPtyId(
      scope.targetId,
      identity.terminalId
    )
    host.terminalPtyIncarnationsByPaneKey[`tab-1:${surfaceBinding.leafId}`] = identity.incarnationId
  }
  host.tabsByWorktree[f.owner][0].ptyId = toAppSshPtyId(
    scope.targetId,
    bindings[0].identity.terminalId
  )
  const local = structuredClone(host)
  delete local.terminalPtyIncarnationsByPaneKey
  local.remoteSessionIdsByTabId = { 'tab-1': host.tabsByWorktree[f.owner][0].ptyId! }
  Object.assign(local.tabsByWorktree[f.owner][0], { createdAt: 1, customTitle: 'UI title' })
  Object.assign(host.tabsByWorktree[f.owner][0], {
    createdAt: 2,
    customTitle: null,
    startupCwd: kind === 'folder' ? '/srv/folder' : '/srv/worktree',
    pendingActivationSpawn: false
  })
  f.state.workspaceSession = local
  f.state.workspaceSessionsByHostId = { [scope.hostId]: host }
  f.state.sshRemotePtyLeases = bindings.map(({ identity, surfaceBinding }) => ({
    targetId: scope.targetId,
    ptyId: identity.terminalId,
    worktreeId: f.owner,
    tabId: surfaceBinding.tabId,
    leafId: surfaceBinding.leafId,
    state: 'attached',
    createdAt: 1,
    updatedAt: 1
  }))
  const recovery = {
    targetId: scope.targetId,
    clientInstanceId: 'client',
    serverBuildId: 'build',
    clientGeneration: 1,
    ownerGeneration: 1,
    ownerLease: 'owner'
  }
  f.state.sshPtyConsumerRecoveries = [recovery]
  const admitted = structuredClone({ bindings, leases: f.state.sshRemotePtyLeases, recovery })
  const project = () =>
    projectOrcadSourceLiveState(f.state, f.manifest.source, f.manifest.payload, admitted)
  const collect = () =>
    collectOrcadMigrationSourceWorkspaceSession(project(), f.manifest.source, f.manifest.payload)
  return { ...f, scope, host, local, admitted, project, collect }
}

it.each(['folder', 'worktree'] as const)(
  'exports one %s session from proven local and SSH mirrors without changing source',
  (kind) => {
    const f = fixture(kind)
    const before = structuredClone(f.state)
    const exported = f.collect()
    expect(exported.blockedCount).toBe(0)
    expect(exported.payload?.tabsByWorktree[f.owner]).toHaveLength(1)
    expect(exported.payload?.tabsByWorktree[f.owner][0]).toMatchObject({
      id: 'tab-1',
      worktreeId: f.owner,
      ptyId: null,
      customTitle: 'UI title',
      createdAt: 1,
      startupCwd: kind === 'folder' ? '/srv/folder' : '/srv/worktree'
    })
    expect(exported.payload?.tabsByWorktree[f.owner][0]).not.toHaveProperty(
      'pendingActivationSpawn'
    )
    expect(exported.payload?.terminalLayoutsByTabId['tab-1']).toMatchObject({
      root: f.local.terminalLayoutsByTabId['tab-1'].root,
      activeLeafId: f.local.terminalLayoutsByTabId['tab-1'].activeLeafId,
      titlesByLeafId: f.local.terminalLayoutsByTabId['tab-1'].titlesByLeafId
    })
    expect(
      Object.values(exported.payload?.terminalLayoutsByTabId['tab-1'].ptyIdsByLeafId ?? {})
    ).toEqual([])
    expect(f.state).toEqual(before)
    expect(f.project().sshRemotePtyLeases).toEqual([])
    expect(f.project().sshPtyConsumerRecoveries).toEqual([])
  }
)

it('rejects a third matching tab in a foreign-host partition', () => {
  const f = fixture()
  f.state.workspaceSessionsByHostId!['ssh:foreign'] = structuredClone(f.host)
  const before = structuredClone(f.state)
  expect(f.project).toThrow('conflict')
  expect(f.state).toEqual(before)
})

it.each(['sessionProfileId', 'sessionPartition'] as const)(
  'refuses browser %s before extraction clears it',
  (field) => {
    const f = fixture()
    f.local.browserTabsByWorktree = {
      [f.owner]: [
        {
          id: 'browser',
          worktreeId: f.owner,
          url: 'about:blank',
          title: 'Browser',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 1,
          [field]: 'private-session'
        }
      ]
    }
    const before = structuredClone(f.state)
    expect(f.project).toThrow('browser-session-binding')
    expect(f.state).toEqual(before)
  }
)

it.each(['id', 'entityId'] as const)(
  'refuses an unproven unified-only terminal %s reference',
  (key) => {
    const f = fixture()
    const tab = {
      id: 'unified-tab',
      entityId: 'unified-entity',
      groupId: 'group',
      worktreeId: f.owner,
      contentType: 'terminal' as const,
      label: 'Unproven',
      customLabel: null,
      color: null,
      sortOrder: 2,
      createdAt: 1
    }
    f.local.unifiedTabs = { [f.owner]: [tab] }
    f.local.remoteSessionIdsByTabId![tab[key]] = 'unproven-session'
    const before = structuredClone(f.state)
    expect(f.project).toThrow('terminal-session-reference')
    expect(f.state).toEqual(before)
  }
)

it('preserves local focus while leaving unrelated workspaces alone', () => {
  const f = fixture('worktree')
  const repoId = f.manifest.payload.repositories[0].id
  Object.assign(f.local, {
    activeRepoId: repoId,
    activeWorktreeId: f.owner,
    activeWorkspaceKey: `worktree:${f.owner}`,
    activeTabId: 'tab-1',
    activeWorkspaceExecutionHostId: f.scope.hostId
  })
  f.local.activeTabIdByWorktree = { [f.owner]: 'tab-1', unrelated: 'other-tab' }
  f.local.tabsByWorktree.unrelated = [
    { ...f.local.tabsByWorktree[f.owner][0], id: 'other-tab', worktreeId: 'unrelated', ptyId: null }
  ]
  const before = structuredClone(f.state)
  const projected = f.project()
  expect(projected.workspaceSession.tabsByWorktree.unrelated).toEqual(
    before.workspaceSession.tabsByWorktree.unrelated
  )
  expect(projected.workspaceSession.activeTabIdByWorktree?.unrelated).toBe('other-tab')
  const host = projected.workspaceSessionsByHostId![f.scope.hostId]!
  expect(host).toMatchObject({
    activeRepoId: repoId,
    activeWorktreeId: f.owner,
    activeWorkspaceKey: `worktree:${f.owner}`,
    activeTabId: 'tab-1',
    activeWorkspaceExecutionHostId: f.scope.hostId
  })
  expect(f.collect().blockedCount).toBe(0)
  expect(f.state).toEqual(before)
})

it.each(['startup', 'custom-title', 'scrollback', 'remote-session', 'closed-tab'] as const)(
  'refuses unexplained mirror %s data instead of overwriting it',
  (change) => {
    const f = fixture()
    if (change === 'startup') {
      f.local.tabsByWorktree[f.owner][0].startupCwd = '/other'
    } else if (change === 'custom-title') {
      f.host.tabsByWorktree[f.owner][0].customTitle = 'Other title'
    } else if (change === 'scrollback') {
      const leaf = f.bindings[0].surfaceBinding.leafId
      f.local.terminalLayoutsByTabId['tab-1'].buffersByLeafId = { [leaf]: 'local output' }
      f.host.terminalLayoutsByTabId['tab-1'].buffersByLeafId = { [leaf]: 'host output' }
    } else if (change === 'remote-session') {
      f.local.remoteSessionIdsByTabId = { 'tab-1': 'foreign-session' }
    } else {
      f.local.closedTerminalTabTombstonesByTabId = { 'tab-1': { closedAt: 1, worktreeId: f.owner } }
    }
    const before = structuredClone(f.state)
    expect(f.project).toThrow('conflict')
    expect(f.state).toEqual(before)
  }
)

it.each(['local', 'host'] as const)(
  'rejects a duplicate tab inside the %s partition',
  (partition) => {
    const f = fixture()
    const session = f[partition]
    session.tabsByWorktree[f.owner].push(structuredClone(session.tabsByWorktree[f.owner][0]))
    const before = structuredClone(f.state)
    expect(f.project).toThrow('conflict')
    expect(f.state).toEqual(before)
  }
)

it.each(['lease', 'recovery'] as const)('rejects changed admitted %s evidence', (change) => {
  const f = fixture()
  if (change === 'lease') {
    f.state.sshRemotePtyLeases[0].updatedAt += 1
  } else {
    f.state.sshPtyConsumerRecoveries![0].ownerLease = 'different-owner'
  }
  const before = structuredClone(f.state)
  expect(f.project).toThrow('orcad_migration_source_live_evidence_changed')
  expect(f.state).toEqual(before)
})

it.each(['primary-pty', 'pane-pty', 'missing-pane-pty', 'incarnation', 'layout', 'owner'] as const)(
  'rejects divergent local mirror %s evidence without mutating source',
  (change) => {
    const f = fixture()
    const pane = `tab-1:${f.bindings[0].surfaceBinding.leafId}`
    if (change === 'primary-pty') {
      f.local.tabsByWorktree[f.owner][0].ptyId = toAppSshPtyId(f.scope.targetId, 'other')
    } else if (change === 'pane-pty') {
      f.local.terminalLayoutsByTabId['tab-1'].ptyIdsByLeafId = {
        [f.bindings[0].surfaceBinding.leafId]: toAppSshPtyId(f.scope.targetId, 'other')
      }
    } else if (change === 'missing-pane-pty') {
      delete f.local.terminalLayoutsByTabId['tab-1'].ptyIdsByLeafId
    } else if (change === 'incarnation') {
      f.local.terminalPtyIncarnationsByPaneKey = { [pane]: 'other-incarnation' }
    } else if (change === 'layout') {
      f.local.terminalLayoutsByTabId['tab-1'].root = { type: 'leaf', leafId: 'other-leaf' }
    } else {
      f.local.tabsByWorktree[f.owner][0].worktreeId = 'folder:other'
    }
    const before = structuredClone(f.state)
    expect(f.project).toThrow('conflict')
    expect(f.state).toEqual(before)
  }
)
