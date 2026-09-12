import { expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { mergeWorkspaceSessions } from '../../orca-profiles/profile-project-session-state'
import { terminalLayoutAdmissionFixture } from './orcad-terminal-layout-admission-test-fixture'
import { projectOrcadLiveSessionForCatalog } from './orcad-live-session-projection'
import {
  prepareOrcadMigrationWorkspaceSession,
  assertCommittedOrcadMigrationWorkspaceSession
} from './orcad-destination-workspace-session'

function fixture(kind: 'folder' | 'worktree', first: number) {
  const f = terminalLayoutAdmissionFixture(kind)
  const incoming = structuredClone(f.manifest.payload.dormantState!.workspaceSession!)
  const tab = incoming.tabsByWorktree[f.owner][0]
  const layout = incoming.terminalLayoutsByTabId[tab.id]
  const reservation = {
    worktreeId: f.owner,
    tab,
    layout,
    bindings: f.bindings.map(({ identity, surfaceBinding }) => ({
      worktreeId: f.owner,
      tabId: tab.id,
      leafId: surfaceBinding.leafId,
      ptyId: surfaceBinding.ptyId,
      incarnationId: identity.incarnationId
    }))
  }
  const current = structuredClone(incoming)
  const binding = reservation.bindings[first]
  current.tabsByWorktree[f.owner][0].ptyId = first === 0 ? binding.ptyId : null
  current.terminalLayoutsByTabId[tab.id].ptyIdsByLeafId = { [binding.leafId]: binding.ptyId }
  current.terminalLayoutsByTabId[tab.id].scrollbackRefsByLeafId = {
    [binding.leafId]: `v1-${'a'.repeat(32)}`
  }
  current.terminalPtyIncarnationsByPaneKey = {
    [`${tab.id}:${binding.leafId}`]: binding.incarnationId
  }
  current.terminalTopologyRevisionByRepoId = { 'repo-1': 9 }
  return { ...f, incoming, current, reservation }
}

it.each([
  ['folder', 0],
  ['folder', 1],
  ['worktree', 0],
  ['worktree', 1]
] as const)(
  'preserves %s live pane %i through dormant comparison and incoming-wins merge',
  (kind, first) => {
    const f = fixture(kind, first)
    const before = structuredClone(f.current)
    const projection = projectOrcadLiveSessionForCatalog(f.current, f.incoming, [f.reservation])
    const prepared = prepareOrcadMigrationWorkspaceSession(f.incoming, {
      ...f.state,
      workspaceSession: projection.comparison
    })
    expect(projection.restoreLiveOverlays(prepared.merged!)).toEqual(
      mergeWorkspaceSessions(before, before)
    )
    expect(() =>
      assertCommittedOrcadMigrationWorkspaceSession(f.incoming, {
        ...f.state,
        workspaceSession: mergeWorkspaceSessions(projection.comparison, projection.comparison)
      })
    ).not.toThrow()
    expect(f.current).toEqual(before)
  }
)

it('fills only missing incoming tabs while retaining a partially materialized live owner', () => {
  const f = fixture('worktree', 0)
  f.incoming.tabsByWorktree[f.owner].push({ ...f.reservation.tab, id: 'dormant-second' })
  expect(() => projectOrcadLiveSessionForCatalog(f.current, f.incoming, [f.reservation])).toThrow(
    'orcad_migration_live_session_owner_conflict'
  )
  const projection = projectOrcadLiveSessionForCatalog(f.current, f.incoming, [f.reservation], {
    allowPartialOwner: true
  })
  const prepared = prepareOrcadMigrationWorkspaceSession(f.incoming, {
    ...f.state,
    workspaceSession: projection.comparison
  })
  const result = projection.restoreLiveOverlays(prepared.merged!)
  expect(result.tabsByWorktree[f.owner]).toEqual([
    f.current.tabsByWorktree[f.owner][0],
    f.incoming.tabsByWorktree[f.owner][1]
  ])
  expect(result.terminalLayoutsByTabId).toEqual(f.current.terminalLayoutsByTabId)
})

it.each(['foreign-tab', 'static-title', 'topology', 'incarnation', 'ref', 'tombstone'])(
  'rejects %s drift without mutation',
  (kind) => {
    const f = fixture('worktree', 0)
    const binding = f.reservation.bindings[0]
    if (kind === 'foreign-tab') {
      f.current.tabsByWorktree[f.owner].push({ ...f.reservation.tab, id: 'foreign' })
    }
    if (kind === 'static-title') {
      f.current.tabsByWorktree[f.owner][0].title = 'changed'
    }
    if (kind === 'topology') {
      f.current.terminalLayoutsByTabId['tab-1'].root = { type: 'leaf', leafId: binding.leafId }
    }
    if (kind === 'incarnation') {
      f.current.terminalPtyIncarnationsByPaneKey![`tab-1:${binding.leafId}`] = 'foreign'
    }
    if (kind === 'ref') {
      f.current.terminalLayoutsByTabId['tab-1'].scrollbackRefsByLeafId![binding.leafId] = 'invalid'
    }
    if (kind === 'tombstone') {
      f.current.closedTerminalTabTombstonesByTabId = {
        'tab-1': { closedAt: 1, worktreeId: f.owner }
      }
    }
    const before = structuredClone(f.current)
    expect(() =>
      projectOrcadLiveSessionForCatalog(f.current, f.incoming, [f.reservation])
    ).toThrow()
    expect(f.current).toEqual(before)
  }
)

it('leaves ordinary unreserved owner conflicts strict', () => {
  const f = fixture('folder', 0)
  const projection = projectOrcadLiveSessionForCatalog(f.current, f.incoming, [])
  expect(() =>
    prepareOrcadMigrationWorkspaceSession(f.incoming, {
      ...f.state,
      workspaceSession: projection.comparison
    })
  ).toThrow()
  expect(
    projectOrcadLiveSessionForCatalog(getDefaultWorkspaceSession(), f.incoming, [f.reservation])
      .comparison
  ).toEqual(getDefaultWorkspaceSession())
})
