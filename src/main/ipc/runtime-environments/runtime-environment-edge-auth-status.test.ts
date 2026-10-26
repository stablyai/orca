import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../../shared/pairing'
import { addEnvironmentFromPairingCode } from '../../../shared/runtime-environment-store'
import {
  getRuntimeEnvironmentStatusOwner,
  resetRuntimeEnvironmentStatusOwners
} from './runtime-environment-request-connections'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../../credentials/runtime-edge-auth-store', () => ({
  readCachedRuntimeEdgeAuth: () => {
    throw new Error('Could not read edge authentication.')
  }
}))
const profiles: string[] = []
afterEach(() => {
  resetRuntimeEnvironmentStatusOwners()
  for (const profile of profiles.splice(0)) {
    rmSync(profile, { recursive: true, force: true })
  }
})
it('publishes unreadable credentials as a status failure without blocking owner creation', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'orca-edge-status-'))
  profiles.push(profile)
  const environment = addEnvironmentFromPairingCode(profile, {
    name: 'protected',
    pairingCode: encodePairingOffer({
      v: 2,
      endpoint: 'wss://orca.example',
      deviceToken: 'synthetic-device',
      publicKeyB64: Buffer.alloc(32, 1).toString('base64')
    })
  })
  const owner = getRuntimeEnvironmentStatusOwner(profile, environment.id)
  owner.activate()
  await vi.waitFor(() => expect(owner.read().status).toBeNull())
  await expect(owner.refresh({ timeoutMs: 1000 })).resolves.toMatchObject({ ok: false })
})
