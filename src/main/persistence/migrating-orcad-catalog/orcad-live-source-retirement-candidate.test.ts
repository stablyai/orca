import { expect, it } from 'vitest'
import { liveSourceRetirementFixture as fixture } from './orcad-live-source-retirement-test-fixture'

it.each(['folder', 'worktree'] as const)(
  'builds a %s retirement candidate without changing current authority',
  (kind) => {
    const f = fixture(kind)
    const before = structuredClone(f.state)
    const candidate = f.run()
    expect(candidate.repos).toEqual([])
    expect(candidate.folderWorkspaces).toEqual([])
    expect(candidate.projectGroups).toEqual([])
    expect(candidate.sshRemotePtyLeases).toEqual([])
    expect(candidate.sshPtyConsumerRecoveries).toEqual([])
    expect(candidate.workspaceSessionsByHostId?.[f.hostId]?.tabsByWorktree ?? {}).toEqual({})
    expect(candidate.sshTargets).toEqual(before.sshTargets)
    expect(candidate.orcadMigrationSourceCutovers).toEqual(before.orcadMigrationSourceCutovers)
    expect(f.state).toEqual(before)
    expect(f.sourceAdmission.assertBindings).toHaveBeenCalledWith(f.cutover.liveTerminalBindings)
    expect(f.sourceAdmission.assertCurrent).toHaveBeenCalledOnce()
  }
)

it.each(['journal', 'fence', 'target', 'catalog', 'lease', 'session', 'authority'] as const)(
  'refuses changed %s evidence without partially retiring current state',
  (change) => {
    const f = fixture()
    if (change === 'journal') {
      f.state.orcadMigrationSourceCutovers = []
    }
    if (change === 'fence') {
      delete f.state.sshTargets[0].owner
    }
    if (change === 'target') {
      f.state.sshTargets[0].generation = 2
    }
    if (change === 'catalog') {
      f.state.repos[0].displayName = 'Changed'
    }
    if (change === 'lease') {
      f.state.sshRemotePtyLeases[0].state = 'expired'
    }
    if (change === 'session') {
      f.state.workspaceSessionsByHostId![f.hostId]!.tabsByWorktree['folder:folder-1'][0].title =
        'Changed'
    }
    if (change === 'authority') {
      f.sourceAdmission.assertCurrent.mockImplementation(() => {
        throw new Error('authority lost')
      })
    }
    const before = structuredClone(f.state)
    const errors = {
      journal: 'orcad_live_cutover_progress_stale',
      fence: 'orcad_migration_source_fence_lost',
      target: 'orcad_migration_source_target_identity_changed',
      catalog: 'orcad_migration_source_catalog_changed',
      lease: 'orcad_migration_source_live_evidence_changed',
      session: 'orcad_migration_source_dependencies_present',
      authority: 'authority lost'
    }
    expect(f.run).toThrow(errors[change])
    expect(f.state).toEqual(before)
  }
)

it('preserves other hosts, their leases and local settings', () => {
  const f = fixture()
  f.state.repos.push({ ...f.state.repos[0], id: 'other', connectionId: 'other-host' })
  f.state.sshRemotePtyLeases.push({
    ...f.state.sshRemotePtyLeases[0],
    targetId: 'other-host',
    ptyId: 'other'
  })
  const before = structuredClone(f.state)
  const candidate = f.run()
  expect(candidate.repos).toEqual([before.repos[1]])
  expect(candidate.sshRemotePtyLeases).toEqual([before.sshRemotePtyLeases[2]])
  expect(candidate.settings).toEqual(before.settings)
  expect(candidate.workspaceSession).toEqual(before.workspaceSession)
  expect(f.state).toEqual(before)
})

it('isolates mutations when projection fails before a complete candidate exists', () => {
  const f = fixture()
  const before = structuredClone(f.state)
  f.sourceAdmission.projectSourceState.mockImplementationOnce((state) => {
    state.repos.length = 0
    state.workspaceSessionsByHostId = {}
    throw new Error('projection failed')
  })
  expect(f.run).toThrow('projection failed')
  expect(f.state).toEqual(before)
})

it('refuses a source-fenced journal even with complete publication evidence', () => {
  const f = fixture()
  Object.assign(f.cutover, { phase: 'source-fenced' })
  const before = structuredClone(f.state)
  expect(f.run).toThrow('orcad_live_source_retirement_commit_required')
  expect(f.state).toEqual(before)
  expect(f.sourceAdmission.projectSourceState).not.toHaveBeenCalled()
})
