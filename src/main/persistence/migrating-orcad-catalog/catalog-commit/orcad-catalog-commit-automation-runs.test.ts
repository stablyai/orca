import { describe, it, expect, vi } from 'vitest'
import {
  createWorkerMaintenanceFixture,
  maintenanceBarrier
} from '../../loading-store/profile-writing/profile-state-maintenance-fixture'
import { ProfileStateWriterError } from '../../profile-state/writer/profile-state-writer-errors'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import {
  DORMANT_AUTOMATION_RUN,
  dormantState,
  manifest
} from './persistence-orcad-migration-catalog-fixture'

vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 1 })
}))
vi.mock('../../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

describe('catalog commit and automation run saves', () => {
  it('keeps imported runs when an older run write fails while the import is saved', async () => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const base = manifest()
    const input = manifest({ payload: { ...base.payload, dormantState: dormantState() } })
    store.stageOrcadMigrationCatalog(input)
    await store.flushPendingOrThrowAsync()

    const started = maintenanceBarrier()
    const finish = maintenanceBarrier()
    vi.spyOn(authority, 'writePreparedState').mockImplementationOnce(async () => {
      started.resolve()
      await finish.promise
      throw new ProfileStateWriterError('disk-refused', 'disk refused', 'known-failure')
    })
    // An unrelated run edit leaves its run list pending and starts a write that stays in flight.
    expect(
      store.snapshotAutomationRunWorkspaceDisplayName(
        hostWorktreeTarget({ id: 'repo-local::/fixture/local', hostId: 'local' }),
        'Renamed workspace'
      )
    ).toBeGreaterThan(0)
    await started.promise

    store.commitStagedOrcadMigrationCatalog(input)
    finish.resolve()
    await store.flushPendingOrThrowAsync()

    expect(readState().automationRuns.map(({ id }: { id: string }) => id)).toContain(
      DORMANT_AUTOMATION_RUN.id
    )
  })
})
