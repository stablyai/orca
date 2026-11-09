import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodePairingOffer } from '../../shared/remote-runtime/pairing/pairing'
import {
  addEnvironmentFromPairingCode,
  listEnvironments
} from '../../shared/remote-runtime/host-store/runtime-environment-store'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import { renameLegacyOrcaCloudEnvironments } from './legacy-orca-cloud-environment-names'

const CLOUD_RUNTIME = '6f1c2a9e-0b4d-4c11-9a3e-7d2f22b5b1e7'
const RECIPE_RUNTIME = '0aa1c2a9-0b4d-4c11-9a3e-7d2f9c0ffee1'

function runtime(
  id: string,
  runtimeEnvironmentId: string,
  recipeId: string
): EphemeralVmRuntimeRecord {
  return { id, recipeId, runtimeEnvironmentId } as EphemeralVmRuntimeRecord
}

describe('renameLegacyOrcaCloudEnvironments', () => {
  let userDataPath: string
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-legacy-cloud-names-'))
  })
  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  function add(name: string, key: number): string {
    return addEnvironmentFromPairingCode(userDataPath, {
      name,
      source: 'ephemeral-vm',
      pairingCode: encodePairingOffer({
        v: 2,
        endpoint: 'wss://server.example/runtime',
        publicKeyB64: Buffer.alloc(32, key).toString('base64'),
        deviceToken: `token-${key}`
      }),
      now: 100
    }).id
  }

  it('renames an Orca Cloud server saved as a VM and leaves recipe VMs alone', () => {
    const cloud = add('repo VM 22b5b1e7', 1)
    const recipe = add('repo VM 9c0ffee1', 2)

    const renamed = renameLegacyOrcaCloudEnvironments(userDataPath, [
      runtime(CLOUD_RUNTIME, cloud, 'cloud'),
      runtime(RECIPE_RUNTIME, recipe, 'docker')
    ])

    expect(renamed).toBe(1)
    const names = Object.fromEntries(
      listEnvironments(userDataPath).map((environment) => [environment.id, environment.name])
    )
    expect(names[cloud]).toBe('repo sandbox 22b5b1e7')
    expect(names[recipe]).toBe('repo VM 9c0ffee1')
    // Idempotent: a second start finds nothing left to rename.
    expect(
      renameLegacyOrcaCloudEnvironments(userDataPath, [runtime(CLOUD_RUNTIME, cloud, 'cloud')])
    ).toBe(0)
  })
})
