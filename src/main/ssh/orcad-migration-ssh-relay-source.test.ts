import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import { closeTestStores, createSqliteTestStore } from '../persistence/persistence-test-harness'
import { Store } from '../persistence/loading-store/store'
import { listOrcadMigrationSourceCutovers } from './orcad-migration-cutover-journal'
import { createOrcadMigrationManifest } from './orcad-migration-manifest-export'
import { createSshRelayMigrationSource } from './orcad-migration-ssh-relay-source'
import { SshTargetOrcadClaims } from './targets/ssh-target-orcad-claims'

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

function setup() {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orcad-ssh-relay-source-'))
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
  const source = createSshRelayMigrationSource({
    userDataPath,
    store,
    claims,
    target: store.getSshTarget(TARGET.id)!
  })
  return { userDataPath, store, source }
}

describe('relay-era SSH migration source', () => {
  it('is the SSH kind, keyed by its target id', () => {
    expect(setup().source).toMatchObject({ kind: 'ssh-relay', journalKey: TARGET.id })
  })

  it('exports exactly what the pre-abstraction export produced', () => {
    const { store, source } = setup()
    const options = {
      migrationId: 'migration-1',
      now: () => new Date('2026-10-01T00:00:00.000Z'),
      destinationEnvironmentId: 'env-1'
    }
    expect(source.exportManifest(options)).toEqual(
      createOrcadMigrationManifest(store, TARGET, options)
    )
    expect(source.collectCatalog().repositories.map((repo) => repo.id)).toEqual(['repo-1'])
  })

  it('never proves exit without a host-wide census', async () => {
    await expect(setup().source.assessTerminals()).resolves.toMatchObject({
      verdict: 'unverifiable'
    })
  })

  it('acquires, verifies, and releases its fence through the journal it is keyed by', async () => {
    const { userDataPath, source } = setup()
    expect(source.resolveFence()).toEqual({ state: 'none' })
    const fenced = await source.acquireFence({
      destinationEnvironmentId: 'env-1',
      destinationName: 'Managed',
      terminalProof: { verdict: 'exited', provenPtyIds: [] }
    })
    expect(fenced.outcome).toBe('fenced')
    const cutover = listOrcadMigrationSourceCutovers(userDataPath)[0]
    expect(cutover.sshTargetId).toBe(source.journalKey)
    expect(() => source.verifyFence(cutover)).not.toThrow()
    await source.releaseFence(cutover)
    expect(listOrcadMigrationSourceCutovers(userDataPath)).toEqual([])
  })
})
