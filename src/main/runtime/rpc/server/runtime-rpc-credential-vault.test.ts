import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { decodePairingOffer } from '../../../../shared/remote-runtime/pairing/pairing'
import { sendRemoteRuntimeRequestOnSocket } from '../../../../shared/remote-runtime/requests/remote-runtime-request-socket'
import { openOrcadSecret, sealOrcadSecret } from '../../../orcad/credentials/orcad-secret-sealing'
import {
  _resetSecretStoreForTests,
  setSecretStore
} from '../../../../shared/secure-storage/secret-store'
import type { RuntimeDeviceGrant } from '../callers/rpc-method-permission'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

it('serves the same encrypted vault to newly authorized pairings but denies standard pairings', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-server-vault-test-'))
  const key = Buffer.alloc(32, 7)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: vault RPC and connection lifecycle only access the members below.
  const runtime = {
    configureNotificationDismissalStore: () => {},
    getRuntimeId: () => 'vault-test-runtime',
    getStartedAt: () => 1,
    machineNameReady: async () => undefined,
    getStatus: () => ({ graphStatus: 'unavailable' }),
    onClientDisconnected: () => {},
    cleanupSubscriptionsForConnection: () => {}
  } as unknown as OrcaRuntimeService
  const server = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath: directory,
    credentialVaultDirectory: directory,
    enableWebSocket: true,
    wsPort: 0
  })
  const callFromNewPairing = async (grants: RuntimeDeviceGrant[], params: unknown) => {
    const offer = server.createPairingOffer({
      address: '127.0.0.1',
      name: 'test device',
      scope: 'runtime',
      grants
    })
    if (!offer.available) {
      throw new Error('Pairing unavailable')
    }
    const { endpoint, publicKeyB64, deviceToken } = decodePairingOffer(offer.pairingUrl)
    return sendRemoteRuntimeRequestOnSocket(
      { endpoint, hostPublicKeyB64: publicKeyB64, credential: { kind: 'token', deviceToken } },
      'credentialVault.operate',
      params,
      5_000
    )
  }
  try {
    setSecretStore({
      isEncryptionAvailable: () => true,
      encryptString: (value) => sealOrcadSecret(key, value),
      decryptString: (cipher) => openOrcadSecret(key, cipher),
      describeProtectionGap: () => 'test host key',
      describeSealing: () => ({ kind: 'host-key', warning: 'test host key' })
    })
    await server.start()
    const draft = {
      kind: 'secret',
      name: 'Deployment token',
      username: '',
      website: '',
      value: 'test-only-token'
    }
    const saved = await callFromNewPairing(['credential-vault'], { op: 'save', draft })
    const summary = {
      id: expect.any(String),
      kind: 'secret',
      name: 'Deployment token',
      username: '',
      website: ''
    }
    expect(saved).toMatchObject({ ok: true, result: { ok: true, value: [summary] } })
    expect(await callFromNewPairing([], { op: 'list' })).toMatchObject({
      ok: false,
      error: { code: 'forbidden' }
    })
    const listed = await callFromNewPairing(['credential-vault'], { op: 'list' })
    expect(listed).toMatchObject({ ok: true, result: { ok: true, value: [summary] } })
    expect(JSON.stringify(listed)).not.toContain('test-only-token')
    const entry = listed.ok ? listed.result : null
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('value' in entry) ||
      !Array.isArray(entry.value)
    ) {
      throw new Error('Vault summaries were not returned')
    }
    const id = entry.value[0]?.id
    expect(await callFromNewPairing(['credential-vault'], { op: 'read', id })).toMatchObject({
      ok: true,
      result: { ok: true, value: 'test-only-token' }
    })
    expect(await callFromNewPairing([], { op: 'read', id })).toMatchObject({
      ok: false,
      error: { code: 'forbidden' }
    })
    const file = join(directory, 'server-credential-vault', 'entries.enc')
    const encrypted = Buffer.from(readFileSync(file, 'utf8'), 'base64')
    expect(encrypted.toString()).not.toContain('Deployment token')
  } finally {
    await server.stop()
    _resetSecretStoreForTests()
    rmSync(directory, { recursive: true, force: true })
  }
})
