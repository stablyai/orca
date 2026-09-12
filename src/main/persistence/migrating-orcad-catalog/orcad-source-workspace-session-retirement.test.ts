import { expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { terminalLayoutAdmissionFixture } from './orcad-terminal-layout-admission-test-fixture'
import { createOrcadMigrationSourceScope } from './orcad-source-scope'
import { removeOwnedSessionState } from './orcad-source-workspace-session-retirement'
import { assertOrcadMigrationSourceWorkspaceSessionRetired } from './orcad-source-workspace-session'

it.each(['folder', 'worktree'] as const)(
  'retires canonical %s selection alongside source session owners',
  (kind) => {
    const f = terminalLayoutAdmissionFixture(kind)
    const scope = createOrcadMigrationSourceScope({
      source: f.manifest.source,
      catalog: f.manifest.payload
    })
    const session = structuredClone(f.manifest.payload.dormantState!.workspaceSession!)
    Object.assign(session, {
      activeRepoId: 'repo-1',
      activeWorktreeId: f.owner,
      activeWorkspaceKey: kind === 'folder' ? f.owner : `worktree:${f.owner}`,
      activeWorkspaceExecutionHostId: scope.hostId
    })
    const before = structuredClone(session)
    const retired = removeOwnedSessionState(session, scope)
    expect(retired).toMatchObject({
      activeRepoId: null,
      activeWorktreeId: null,
      activeWorkspaceKey: null,
      activeWorkspaceExecutionHostId: null
    })
    expect(session).toEqual(before)
    f.state.workspaceSession = retired
    f.state.workspaceSessionsByHostId = {}
    expect(() =>
      assertOrcadMigrationSourceWorkspaceSessionRetired(f.state, f.manifest)
    ).not.toThrow()
  }
)

it('retires selection-only source references without changing unrelated selections or input', () => {
  const f = terminalLayoutAdmissionFixture()
  const scope = createOrcadMigrationSourceScope({
    source: f.manifest.source,
    catalog: f.manifest.payload
  })
  const session = getDefaultWorkspaceSession()
  session.activeWorkspaceKey = 'worktree:repo-1::/srv/worktree'
  session.activeWorkspaceExecutionHostId = scope.hostId
  const before = structuredClone(session)
  expect(removeOwnedSessionState(session, scope)).toMatchObject({
    activeWorkspaceKey: null,
    activeWorkspaceExecutionHostId: null
  })
  expect(session).toEqual(before)
  session.activeWorkspaceKey = 'worktree:other-repo::/elsewhere'
  session.activeRepoId = 'other-repo'
  session.activeWorktreeId = 'other-repo::/elsewhere'
  session.activeWorkspaceExecutionHostId = 'runtime:other'
  expect(removeOwnedSessionState(session, scope)).toEqual(session)
})
