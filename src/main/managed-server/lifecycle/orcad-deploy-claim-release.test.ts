import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeEnvironmentStoreError } from '../../../shared/remote-runtime/host-store/runtime-environment-store-records'
import { getManagedOrcadFenceEnvironmentId } from '../../../shared/remote-runtime/ssh/managed-orcad-ssh-owner'
import { closeTestStores, createSqliteTestStore } from '../../persistence/persistence-test-harness'
import { Store } from '../../persistence/loading-store/store'
import { SshTargetOrcadClaims } from '../../ssh/targets/ssh-target-orcad-claims'
import { releaseClaimIfStoreRefused } from './orcad-deploy-claim-release'

const directories: string[] = []
afterEach(async () => {
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('releaseClaimIfStoreRefused', () => {
  it('releases the SSH claim only when the store refused the registration', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orcad-deploy-claim-release-'))
    directories.push(userDataPath)
    const store = createSqliteTestStore(Store, { dataFile: join(userDataPath, 'orca-data.json') })
    store.addSshTarget({
      id: 'ssh-other',
      label: 'other',
      host: 'other',
      port: 22,
      username: 'user'
    })
    const claims = new SshTargetOrcadClaims(store)
    claims.claim('ssh-other', 'provisional', { deployName: 'dell', ownerRecorded: false })
    const args = { targetId: 'ssh-other', environmentId: 'provisional' }
    const claim = () => {
      const target = store.getSshTarget('ssh-other')
      return [getManagedOrcadFenceEnvironmentId(target), target?.orcadProvisioning?.name]
    }

    await releaseClaimIfStoreRefused(claims, new Error('SSH connection lost'), args)
    expect(claim()).toEqual(['provisional', 'dell'])

    const refusal = new RuntimeEnvironmentStoreError(
      'invalid_argument',
      'A server named "dell" already exists.'
    )
    await releaseClaimIfStoreRefused(claims, refusal, args)
    expect(claim()).toEqual([null, undefined])
  })
})
