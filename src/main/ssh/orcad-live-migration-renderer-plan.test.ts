import { beforeEach, expect, it, vi } from 'vitest'
import { getOrcadLiveMigrationRendererPlan } from './orcad-live-migration-renderer-plan'
import { liveSourceRetirementFixture } from '../persistence/migrating-orcad-catalog/orcad-live-source-retirement-test-fixture'
import { createOrcadLiveSourceRetirementRecord } from './orcad-live-source-retirement-record'
import { createOrcadLiveCompletedCutover } from './orcad-live-completed-cutover'

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), validate: vi.fn() }))
vi.mock('../../shared/runtime-environment-store', () => ({ resolveEnvironment: mocks.resolve }))
vi.mock('./orcad-live-completed-recovery', () => ({
  validateOrcadLiveCompletedRecovery: mocks.validate
}))
beforeEach(() => vi.resetAllMocks())

function fixture(kind: 'folder' | 'worktree') {
  const f = liveSourceRetirementFixture(kind)
  const release = {
    version: 1,
    cutover: f.cutover,
    activations: f.cutover.terminalPublications!.map((entry) => ({
      version: 1,
      identity: entry.identity,
      publicationReceipt: entry.publicationReceipt,
      destinationClaim: { generation: 1, claimId: 'private-claim' },
      catalog: entry.catalog
    }))
  }
  const record = createOrcadLiveSourceRetirementRecord({
    state: f.state,
    sourceAdmission: f.sourceAdmission,
    release
  })
  const completed = createOrcadLiveCompletedCutover({
    committed: f.cutover,
    completionEvidence: {
      version: 1,
      retirementRecordSha256: record.sha256,
      sourceRouteCheckpointSha256: 'b'.repeat(64)
    },
    retiredAt: '2026-09-08T12:00:00.000Z'
  })
  const evidence = { record, completed }
  const store = {
    getOrcadLiveMigrationRendererEvidence: vi.fn(() => evidence),
    getProfileStorageDirectory: () => '/store-profile'
  }
  mocks.resolve.mockReturnValue({
    id: f.cutover.destinationEnvironmentId,
    runtimeId: f.cutover.liveTerminalBindings![0].identity.destinationRuntimeId,
    secret: 'pairing-secret'
  })
  mocks.validate.mockReturnValue(evidence)
  const selection = { selector: ' environment ', migrationId: f.cutover.manifest.migrationId }
  const run = () => getOrcadLiveMigrationRendererPlan('/environment-profile', store, selection)
  return { ...f, record, completed, store, selection, run }
}

it.each(['folder', 'worktree'] as const)(
  'returns only exact public %s placements and catalog IDs',
  (kind) => {
    const f = fixture(kind)
    const plan = f.run()
    expect(plan).toEqual({
      version: 1,
      migrationId: f.selection.migrationId,
      retirementRecordSha256: f.record.sha256,
      sourceSshTargetId: f.cutover.manifest.source.sshTargetId,
      destinationEnvironmentId: f.cutover.destinationEnvironmentId,
      destinationRuntimeId: f.cutover.liveTerminalBindings![0].identity.destinationRuntimeId,
      sourceCatalog: {
        repoIds: f.cutover.manifest.payload.repositories.map(({ id }) => id),
        projectGroupIds: f.cutover.manifest.payload.projectGroups.map(({ id }) => id),
        folderWorkspaceIds: f.cutover.manifest.payload.folderWorkspaces.map(({ id }) => id)
      },
      workspaces: [
        {
          workspaceId: kind === 'folder' ? 'folder:folder-1' : 'repo-1::/srv/worktree',
          terminals: f.cutover.liveTerminalBindings!.map(({ identity, surfaceBinding }) => ({
            tabId: surfaceBinding.tabId,
            leafId: surfaceBinding.leafId,
            sourcePtyId: `ssh:${f.cutover.manifest.source.sshTargetId}@@${identity.terminalId}`,
            incarnationId: identity.incarnationId
          }))
        }
      ]
    })
    expect(mocks.resolve).toHaveBeenCalledWith('/environment-profile', 'environment')
    expect(mocks.validate).toHaveBeenCalledWith('/environment-profile', f.completed)
    const serialized = JSON.stringify(plan)
    for (const secret of [
      'ownerLease',
      'workspaceSession',
      'publicationReceipt',
      'private-claim',
      'pairing-secret'
    ]) {
      expect(serialized).not.toContain(secret)
    }
  }
)

it.each(['environment', 'runtime'] as const)(
  'refuses a changed destination %s before recovery reads',
  (field) => {
    const f = fixture('folder')
    const environment = mocks.resolve()
    mocks.resolve.mockReturnValue({
      ...environment,
      [field === 'runtime' ? 'runtimeId' : 'id']: 'foreign'
    })
    expect(f.run).toThrow('destination_changed')
    expect(mocks.validate).not.toHaveBeenCalled()
  }
)

it.each([
  'retirement_missing',
  'completion_required',
  'publication_evidence_invalid',
  'source_fence_lost'
])('propagates current Store refusal %s without publishing a partial plan', (reason) => {
  const f = fixture('folder')
  f.store.getOrcadLiveMigrationRendererEvidence.mockImplementation(() => {
    throw new Error(reason)
  })
  expect(f.run).toThrow(reason)
  expect(mocks.validate).not.toHaveBeenCalled()
})

it('rejects tampered or missing retained completion evidence', () => {
  const f = fixture('worktree')
  mocks.validate.mockReturnValue({
    record: { ...f.record, sha256: 'c'.repeat(64) },
    completed: f.completed
  })
  expect(f.run).toThrow('evidence_changed')
  mocks.validate.mockImplementation(() => {
    throw new Error('retained_completion_missing')
  })
  expect(f.run).toThrow('retained_completion_missing')
})

it('projects main-validated dormant workspace IDs without inventing terminal bindings', () => {
  const f = fixture('worktree')
  const payload = f.record.release.cutover.manifest.payload
  payload.folderWorkspaces.push({
    ...liveSourceRetirementFixture('folder').cutover.manifest.payload.folderWorkspaces[0],
    id: 'dormant-folder'
  })
  payload.dormantState!.workspaceSession!.activeTabIdByWorktree ??= {}
  payload.dormantState!.workspaceSession!.activeTabIdByWorktree!['repo-1::/srv/dormant'] = null
  const result = f.run()
  expect(result.sourceCatalog.folderWorkspaceIds).toContain('dormant-folder')
  expect(result.workspaces).toContainEqual({ workspaceId: 'folder:dormant-folder', terminals: [] })
  expect(result.workspaces).toContainEqual({ workspaceId: 'repo-1::/srv/dormant', terminals: [] })
  expect(
    result.workspaces.reduce((count, workspace) => count + workspace.terminals.length, 0)
  ).toBe(f.cutover.liveTerminalBindings!.length)
})

it('rejects a foreign migration returned by the main evidence port', () => {
  const f = fixture('folder')
  f.selection.migrationId = 'foreign'
  expect(f.run).toThrow('retirement_missing')
  expect(mocks.validate).not.toHaveBeenCalled()
})

it.each([
  {},
  { selector: '', migrationId: 'migration' },
  { selector: 'environment', migrationId: '' }
])('rejects malformed selection before trusted evidence reads %j', (value) => {
  const f = fixture('folder')
  expect(() => getOrcadLiveMigrationRendererPlan('/profile', f.store, value as never)).toThrow()
  expect(f.store.getOrcadLiveMigrationRendererEvidence).not.toHaveBeenCalled()
})
