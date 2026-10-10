import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getManagedOrcadFenceEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import type { SshTarget } from '../../shared/ssh-types'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { Store } from '../persistence/loading-store/store'
import {
  abortOrcadMigrationCutover,
  commitOrcadMigrationDestination,
  stageOrcadMigrationDestination,
  type OrcadMigrationCutoverContext
} from './orcad-migration-cutover-coordinator'
import { ORCAD_MIGRATION_DESTINATION_UNSUPPORTED } from './orcad-migration-catalog-client'
import { listOrcadMigrationSourceCutovers } from './orcad-migration-cutover-journal'
import { fenceOrcadMigrationSource } from './orcad-migration-source-fence'
import { SshTargetOrcadClaims } from './ssh-target-orcad-claims'
import { fakeOrcadMigrationDestination as fakeDestination } from './orcad-migration-destination-fake'

const TARGET: SshTarget = {
  id: 'ssh-prod',
  label: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'deploy',
  generation: 2
}

const directories: string[] = []
afterEach(async () => {
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

async function setup() {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orcad-cutover-coordinator-'))
  directories.push(userDataPath)
  const store = createSqliteTestStore(Store, { dataFile: join(userDataPath, 'orca-data.json') })
  store.addSshTarget(TARGET)
  store.addRepo({
    id: 'repo-1',
    path: '/srv/app',
    displayName: 'App',
    badgeColor: '#737373',
    addedAt: 1,
    kind: 'git',
    connectionId: TARGET.id
  })
  const claims = new SshTargetOrcadClaims(store)
  const fenced = await fenceOrcadMigrationSource({
    userDataPath,
    store,
    claims,
    targetId: TARGET.id,
    destinationEnvironmentId: 'env-1',
    destinationName: 'Managed',
    terminalProof: { verdict: 'exited', provenPtyIds: [] },
    hasDirectSshAuthority: () => false
  })
  if (fenced.outcome !== 'fenced') {
    throw new Error('expected a fence')
  }
  const destination = fakeDestination()
  const context: OrcadMigrationCutoverContext = { userDataPath, store, claims, destination }
  const journal = () => listOrcadMigrationSourceCutovers(userDataPath)[0]
  const owner = () => getManagedOrcadFenceEnvironmentId(store.getSshTarget(TARGET.id))
  return { context, destination, store, migrationId: fenced.cutover.migrationId, journal, owner }
}

describe('migration cutover coordinator', () => {
  it('stages then commits once, journaling each phase the destination proves', async () => {
    const h = await setup()
    await expect(stageOrcadMigrationDestination(h.context, h.migrationId)).resolves.toMatchObject({
      phase: 'destination-staged'
    })
    expect(h.journal()?.phase).toBe('destination-staged')
    await expect(commitOrcadMigrationDestination(h.context, h.migrationId)).resolves.toMatchObject({
      phase: 'destination-committed'
    })
    expect(h.journal()?.phase).toBe('destination-committed')
    await commitOrcadMigrationDestination(h.context, h.migrationId)
    expect(h.destination.commits).toBe(1)
  })

  it('reads a lost commit reply back from the destination instead of failing or retrying blind', async () => {
    const h = await setup()
    await stageOrcadMigrationDestination(h.context, h.migrationId)
    const commit = h.destination.commit.getMockImplementation()!
    h.destination.commit.mockImplementationOnce(async (manifest) => {
      await commit(manifest)
      throw new Error('socket closed')
    })
    await expect(commitOrcadMigrationDestination(h.context, h.migrationId)).resolves.toMatchObject({
      phase: 'destination-committed'
    })
    expect(h.destination.commits).toBe(1)
  })

  it('never journals a commit the server holds only in memory, until its flush succeeds', async () => {
    const h = await setup()
    await stageOrcadMigrationDestination(h.context, h.migrationId)
    const commit = h.destination.commit.getMockImplementation()!
    let diskFull = true
    // The receipt lands in memory, so reads say committed, but the flush keeps failing.
    h.destination.commit.mockImplementation(async (manifest) => {
      const state = await commit(manifest)
      if (diskFull) {
        throw new Error('disk full')
      }
      return state
    })
    await expect(commitOrcadMigrationDestination(h.context, h.migrationId)).rejects.toThrow(
      'disk full'
    )
    await expect(commitOrcadMigrationDestination(h.context, h.migrationId)).rejects.toThrow(
      'disk full'
    )
    await expect(abortOrcadMigrationCutover(h.context, h.migrationId)).rejects.toThrow('disk full')
    expect(h.journal()?.phase).toBe('destination-staged')
    expect(h.owner()).toBe('env-1')

    diskFull = false
    await expect(commitOrcadMigrationDestination(h.context, h.migrationId)).resolves.toMatchObject({
      phase: 'destination-committed'
    })
  })

  it('keeps the journal at staged when the commit reply and the re-read are both lost', async () => {
    const h = await setup()
    await stageOrcadMigrationDestination(h.context, h.migrationId)
    h.destination.commit.mockRejectedValueOnce(new Error('socket closed'))
    h.destination.readState.mockRejectedValueOnce(new Error('socket closed'))
    await expect(commitOrcadMigrationDestination(h.context, h.migrationId)).rejects.toThrow(
      'socket closed'
    )
    expect(h.journal()?.phase).toBe('destination-staged')
    expect(h.owner()).toBe('env-1')
  })

  it.each([
    [
      'a source row changed',
      (store: Store) => store.updateRepo('repo-1', { displayName: 'Renamed' }),
      'orcad_migration_source_changed'
    ],
    [
      'a terminal started on the source',
      (store: Store) =>
        store.upsertSshRemotePtyLease({ targetId: TARGET.id, ptyId: 'late', state: 'attached' }),
      'orcad_migration_source_terminals_live'
    ]
  ])('refuses to stage or commit after %s', async (_label, change, code) => {
    const h = await setup()
    change(h.store)
    await expect(stageOrcadMigrationDestination(h.context, h.migrationId)).rejects.toThrow(code)
    expect(h.destination.stage).not.toHaveBeenCalled()
  })

  it('refuses a commit whose source changed after staging', async () => {
    const h = await setup()
    await stageOrcadMigrationDestination(h.context, h.migrationId)
    h.store.updateRepo('repo-1', { displayName: 'Renamed' })
    await expect(commitOrcadMigrationDestination(h.context, h.migrationId)).rejects.toThrow(
      'orcad_migration_source_changed'
    )
    expect(h.destination.commit).not.toHaveBeenCalled()
  })

  it('aborts a stage and releases the fence only once the destination proves it absent', async () => {
    const h = await setup()
    await stageOrcadMigrationDestination(h.context, h.migrationId)
    await expect(abortOrcadMigrationCutover(h.context, h.migrationId)).resolves.toEqual({
      outcome: 'released',
      evidence: 'catalog-absent'
    })
    expect(h.owner()).toBeNull()
    expect(h.journal()).toBeUndefined()
  })

  it('keeps the fence when the abort answer is lost and the destination cannot be read', async () => {
    const h = await setup()
    await stageOrcadMigrationDestination(h.context, h.migrationId)
    h.destination.abort.mockRejectedValueOnce(new Error('socket closed'))
    h.destination.readState.mockResolvedValueOnce({
      state: 'absent',
      migrationId: h.migrationId,
      manifestSha256: h.journal()!.manifestSha256
    })
    h.destination.readState.mockRejectedValueOnce(new Error('socket closed'))
    h.destination.abort.mockRejectedValueOnce(new Error('socket closed'))
    await expect(abortOrcadMigrationCutover(h.context, h.migrationId)).rejects.toThrow(
      'socket closed'
    )
    expect(h.owner()).toBe('env-1')
    expect(h.journal()?.phase).toBe('destination-staged')
  })

  it('never releases a committed destination, even when the journal lags behind it', async () => {
    const h = await setup()
    await stageOrcadMigrationDestination(h.context, h.migrationId)
    await h.destination.commit(h.journal()!.manifest)
    await expect(abortOrcadMigrationCutover(h.context, h.migrationId)).resolves.toMatchObject({
      outcome: 'refused',
      code: 'orcad_migration_committed_source_cannot_be_released'
    })
    expect(h.journal()?.phase).toBe('destination-committed')
    expect(h.owner()).toBe('env-1')
    await expect(abortOrcadMigrationCutover(h.context, h.migrationId)).resolves.toMatchObject({
      outcome: 'refused'
    })
  })

  it('releases on an unsupported destination only before anything was staged', async () => {
    const unsupported = new Error(ORCAD_MIGRATION_DESTINATION_UNSUPPORTED)
    const fresh = await setup()
    fresh.destination.readState.mockRejectedValueOnce(unsupported)
    await expect(abortOrcadMigrationCutover(fresh.context, fresh.migrationId)).resolves.toEqual({
      outcome: 'released',
      evidence: 'destination-unsupported'
    })
    expect(fresh.owner()).toBeNull()

    const staged = await setup()
    await stageOrcadMigrationDestination(staged.context, staged.migrationId)
    staged.destination.readState.mockRejectedValueOnce(unsupported)
    await expect(abortOrcadMigrationCutover(staged.context, staged.migrationId)).rejects.toThrow(
      ORCAD_MIGRATION_DESTINATION_UNSUPPORTED
    )
    expect(staged.owner()).toBe('env-1')
  })

  it('treats any other read failure at abort as unverifiable and keeps the fence', async () => {
    const h = await setup()
    h.destination.readState.mockRejectedValueOnce(new Error('socket closed'))
    await expect(abortOrcadMigrationCutover(h.context, h.migrationId)).rejects.toThrow(
      'socket closed'
    )
    expect(h.owner()).toBe('env-1')
  })

  it('refuses a destination answer for another manifest', async () => {
    const h = await setup()
    h.destination.stage.mockResolvedValueOnce({
      state: 'staged',
      migrationId: h.migrationId,
      manifestSha256: 'f'.repeat(64),
      stagedAt: '2026-10-01T00:00:00.000Z'
    })
    await expect(stageOrcadMigrationDestination(h.context, h.migrationId)).rejects.toThrow(
      'orcad_migration_destination_state_mismatch'
    )
    expect(h.journal()?.phase).toBe('source-fenced')
  })
})
