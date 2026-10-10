import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getManagedOrcadFenceEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import { addManagedOrcadEnvironment } from '../../shared/runtime-environment-managed-orcad-store'
import { listEnvironments } from '../../shared/runtime-environment-store'
import type { SshTarget } from '../../shared/ssh-types'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { Store } from '../persistence/loading-store/store'
import { stageOrcadMigrationDestination } from './orcad-migration-cutover-coordinator'
import { listOrcadMigrationSourceCutovers } from './orcad-migration-cutover-journal'
import { fakeOrcadMigrationDestination } from './orcad-migration-destination-fake'
import { fenceOrcadMigrationSource } from './orcad-migration-source-fence'
import { releaseUnreachableOrcadSetup } from './orcad-unreachable-setup-release'
import { SshTargetOrcadClaims } from './ssh-target-orcad-claims'

const TARGET: SshTarget = {
  id: 'ssh-locked',
  label: 'Locked down',
  host: 'locked.example.com',
  port: 22,
  username: 'dev',
  generation: 2
}
const LOCAL_PORT = 46_900

const directories: string[] = []
afterEach(async () => {
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** A conversion that fenced the host and registered its server, then could not reach it. */
async function strandedConversion() {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orcad-unreachable-setup-'))
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
  addManagedOrcadEnvironment(userDataPath, {
    id: 'env-1',
    name: 'Managed',
    pairingCode: encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint: `ws://127.0.0.1:${LOCAL_PORT}/`,
      deviceToken: 'device-token',
      publicKeyB64: 'public-key'
    }),
    orcadDeployment: {
      sshTargetId: TARGET.id,
      sshTargetGeneration: store.getSshTarget(TARGET.id)!.generation!,
      localPort: LOCAL_PORT,
      remotePort: 6_768
    }
  })
  return { userDataPath, store, claims, migrationId: fenced.cutover.migrationId }
}

describe('releasing a setup the host never let this client reach', () => {
  it('unregisters the server and releases the fence, keeping every source row', async () => {
    const h = await strandedConversion()

    await releaseUnreachableOrcadSetup({ ...h, targetId: TARGET.id })

    expect(getManagedOrcadFenceEnvironmentId(h.store.getSshTarget(TARGET.id))).toBeNull()
    expect(listOrcadMigrationSourceCutovers(h.userDataPath)).toEqual([])
    expect(listEnvironments(h.userDataPath)).toEqual([])
    expect(h.store.getRepos()).toEqual([expect.objectContaining({ id: 'repo-1' })])
  })

  it('leaves a server that already holds staged state alone', async () => {
    const h = await strandedConversion()
    const destination = fakeOrcadMigrationDestination()
    await stageOrcadMigrationDestination(
      { userDataPath: h.userDataPath, store: h.store, claims: h.claims, destination },
      h.migrationId
    )

    await releaseUnreachableOrcadSetup({ ...h, targetId: TARGET.id })

    expect(getManagedOrcadFenceEnvironmentId(h.store.getSshTarget(TARGET.id))).toBe('env-1')
    expect(listEnvironments(h.userDataPath)).toHaveLength(1)
  })
})
