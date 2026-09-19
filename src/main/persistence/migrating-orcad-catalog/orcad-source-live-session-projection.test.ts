import { expect, it } from 'vitest'
import { toAppSshPtyId } from '../../../shared/ssh-pty-id'
import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import { projectOrcadSourceLiveSession } from './orcad-source-live-session-projection'
import { createOrcadMigrationSourceScope } from './orcad-source-scope'
import { terminalLayoutAdmissionFixture } from './orcad-terminal-layout-admission-test-fixture'
import { collectOrcadMigrationSourceWorkspaceSession } from './orcad-source-workspace-session'

function fixture(kind: 'folder' | 'worktree' = 'folder') {
  const f = terminalLayoutAdmissionFixture(kind)
  const scope = createOrcadMigrationSourceScope({
    source: f.manifest.source,
    catalog: f.manifest.payload
  })
  const session = structuredClone(f.manifest.payload.dormantState!.workspaceSession!)
  session.terminalPtyIncarnationsByPaneKey = {}
  session.terminalLayoutsByTabId['tab-1'].ptyIdsByLeafId = {}
  for (const { identity, surfaceBinding } of f.bindings) {
    session.terminalLayoutsByTabId['tab-1'].ptyIdsByLeafId![surfaceBinding.leafId] = toAppSshPtyId(
      scope.targetId,
      identity.terminalId
    )
    session.terminalPtyIncarnationsByPaneKey[`${surfaceBinding.tabId}:${surfaceBinding.leafId}`] =
      identity.incarnationId
  }
  session.tabsByWorktree[f.owner][0].ptyId = toAppSshPtyId(
    scope.targetId,
    f.bindings[0].identity.terminalId
  )
  const collect = (candidate = session) =>
    collectOrcadMigrationSourceWorkspaceSession(
      { ...f.state, workspaceSessionsByHostId: { [scope.hostId]: candidate } },
      f.manifest.source,
      f.manifest.payload
    )
  return { ...f, scope, session, collect }
}

it.each(['folder', 'worktree'] as const)(
  'exports a %s split through existing dormant collection without mutating source',
  (kind) => {
    const f = fixture(kind)
    const before = structuredClone(f.session)
    expect(f.collect().blockedCount).toBeGreaterThan(0)
    const projected = projectOrcadSourceLiveSession(f.session, f.scope, f.bindings)
    const exported = f.collect(projected)
    expect(exported.blockedCount).toBe(0)
    expect(exported.payload?.terminalLayoutsByTabId['tab-1'].root).toEqual(
      before.terminalLayoutsByTabId['tab-1'].root
    )
    expect(exported.payload?.tabsByWorktree[f.owner][0]).toEqual({
      ...before.tabsByWorktree[f.owner][0],
      ptyId: null
    })
    expect(f.session).toEqual(before)
    expect(projectOrcadSourceLiveSession(f.session, f.scope, f.bindings.toReversed())).toEqual(
      projected
    )
  }
)

it('leaves unproven siblings blocking the existing exporter', () => {
  const f = fixture()
  const projected = projectOrcadSourceLiveSession(f.session, f.scope, [f.bindings[0]])
  expect(f.collect(projected).blockedCount).toBeGreaterThan(0)
  expect(f.collect(projected).payload).toBeUndefined()
  expect(projected.terminalLayoutsByTabId['tab-1'].ptyIdsByLeafId).toEqual({
    [f.bindings[1].surfaceBinding.leafId]: toAppSshPtyId(
      f.scope.targetId,
      f.bindings[1].identity.terminalId
    )
  })
})

it.each(['source', 'other', 'unknown'] as const)(
  'checks explicitly qualified %s owner identity',
  (host) => {
    const f = fixture('worktree')
    const key = composeWorktreeHostIdentity(
      host === 'source' ? f.scope.hostId : host === 'other' ? 'ssh:other' : undefined,
      f.owner
    )
    f.session.tabsByWorktree[key] = f.session.tabsByWorktree[f.owner]
    delete f.session.tabsByWorktree[f.owner]
    f.session.tabsByWorktree[key][0].worktreeId = key
    const project = () => projectOrcadSourceLiveSession(f.session, f.scope, f.bindings)
    if (host === 'source') {
      expect(f.collect(project()).blockedCount).toBe(0)
    } else {
      expect(project).toThrow('projection_conflict')
    }
  }
)

it.each(['incarnation', 'host', 'owner', 'missing', 'duplicate', 'destination'] as const)(
  'refuses %s placement evidence without mutating source',
  (change) => {
    const f = fixture()
    const bindings = structuredClone([...f.bindings])
    if (change === 'incarnation') {
      Object.assign(bindings[0].identity, { incarnationId: 'other' })
    } else if (change === 'host') {
      f.scope.targetId = 'other'
    } else if (change === 'owner') {
      Object.assign(bindings[0].surfaceBinding, { workspaceKey: 'folder:other' })
    } else if (change === 'missing') {
      delete f.session.terminalLayoutsByTabId['tab-1'].ptyIdsByLeafId
    } else if (change === 'duplicate') {
      bindings.push(bindings[0])
    } else {
      Object.assign(bindings[1].identity, { destinationRuntimeId: 'other' })
    }
    const before = structuredClone(f.session)
    expect(() => projectOrcadSourceLiveSession(f.session, f.scope, bindings)).toThrow(
      'projection_conflict'
    )
    expect(f.session).toEqual(before)
  }
)

it('does not erase remote-session authority or unmatched primary PTY references', () => {
  const f = fixture()
  f.session.remoteSessionIdsByTabId = { 'tab-1': 'unproven-session' }
  f.session.tabsByWorktree[f.owner][0].ptyId = 'unproven-pty'
  const projected = projectOrcadSourceLiveSession(f.session, f.scope, f.bindings)
  expect(projected.remoteSessionIdsByTabId).toEqual(f.session.remoteSessionIdsByTabId)
  expect(projected.tabsByWorktree[f.owner][0].ptyId).toBe('unproven-pty')
  expect(f.collect(projected).blockedCount).toBeGreaterThan(0)
})
