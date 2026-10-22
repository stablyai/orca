import { removeTree } from '../../../shared/windows-transient-lock-removal'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer, parsePairingCode } from '../../../shared/pairing'
import { generateKeyPair, publicKeyToBase64 } from '../../../shared/e2ee-crypto'
import {
  listEnvironments,
  addEnvironmentFromPairingCode
} from '../../../shared/runtime-environment-store'
import {
  verifyAndAddRuntimeEnvironmentFromPairingCode,
  verifyAndRepairRuntimeEnvironmentFromPairingCode
} from './runtime-environment-pairing-verification'
const mocks = vi.hoisted(() => ({ send: vi.fn(), write: vi.fn(), read: vi.fn() }))
vi.mock('../../../shared/remote-runtime-client', () => ({ sendRemoteRuntimeRequest: mocks.send }))
vi.mock('../../credentials/runtime-edge-auth-store', () => ({
  writeRuntimeEdgeAuth: mocks.write,
  readRuntimeEdgeAuth: mocks.read
}))
let directory: string
const code = encodePairingOffer({
  v: 2,
  endpoint: 'wss://orca.example',
  deviceToken: 'synthetic-device',
  publicKeyB64: publicKeyToBase64(generateKeyPair().publicKey)
})
const headers = [{ name: 'X-Token', value: 'synthetic-secret' }]
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-pair-edge-'))
  mocks.write.mockReset()
  mocks.read.mockReset().mockReturnValue(null)
  mocks.send.mockReset().mockResolvedValue({
    ok: true,
    _meta: { runtimeId: 'test-runtime' },
    result: {
      runtimeId: 'test-runtime',
      rendererGraphEpoch: 1,
      graphStatus: 'ready',
      authoritativeWindowId: null,
      liveTabCount: 0,
      liveLeafCount: 0,
      protocolVersion: 999999
    }
  })
})
afterEach(() => removeTree(directory))
describe('verified desktop pairing edge credentials', () => {
  it('uses transient headers during verification and stores only after the host commits', async () => {
    mocks.write.mockImplementation(() => {
      expect(listEnvironments(directory)).toHaveLength(1)
    })
    const result = await verifyAndAddRuntimeEnvironmentFromPairingCode(directory, {
      name: 'server',
      pairingCode: code,
      edgeAuthHeaders: headers
    })
    expect(result.ok).toBe(true)
    expect(mocks.send.mock.calls[0]?.[0].edgeAuth.headers).toEqual({
      'X-Token': 'synthetic-secret'
    })
    expect(mocks.write).toHaveBeenCalledOnce()
    expect(JSON.stringify(result)).not.toContain('synthetic-secret')
  })
  it('rejects invalid headers before opening any socket', async () => {
    const result = await verifyAndAddRuntimeEnvironmentFromPairingCode(directory, {
      name: 'server',
      pairingCode: code,
      edgeAuthHeaders: [{ name: 'X', value: 'bad\nsecret' }]
    })
    expect(result.ok).toBe(false)
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.write).not.toHaveBeenCalled()
  })
  it('never saves credentials after failed pinned identity verification', async () => {
    mocks.send.mockRejectedValue(new Error('failed identity'))
    await verifyAndAddRuntimeEnvironmentFromPairingCode(directory, {
      name: 'server',
      pairingCode: code,
      edgeAuthHeaders: headers
    })
    expect(mocks.write).not.toHaveBeenCalled()
    expect(listEnvironments(directory)).toHaveLength(0)
  })
  it('reports committed metadata with a guarded storage-only retry after encryption failure', async () => {
    mocks.write.mockImplementation(() => {
      throw new Error('synthetic-secret keychain failure')
    })
    const result = await verifyAndAddRuntimeEnvironmentFromPairingCode(directory, {
      name: 'server',
      pairingCode: code,
      edgeAuthHeaders: headers
    })
    expect(result).toMatchObject({
      ok: false,
      kind: 'environment-save-failed',
      savedEnvironmentId: expect.any(String),
      savedEnvironmentPairingRevision: expect.any(Number)
    })
    expect(listEnvironments(directory)).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain('synthetic-secret')
  })
  it('does not clear or replace stored credentials for omitted/blank input', async () => {
    await verifyAndAddRuntimeEnvironmentFromPairingCode(directory, {
      name: 'server',
      pairingCode: code,
      edgeAuthHeaders: [{ name: '', value: '' }]
    })
    expect(mocks.write).not.toHaveBeenCalled()
  })
  it('never rebinds saved headers to a changed origin during repair', async () => {
    const offer = parsePairingCode(code)
    if (!offer) {
      throw new Error('Invalid test offer')
    }
    const saved = addEnvironmentFromPairingCode(directory, { name: 'server', pairingCode: code })
    mocks.read.mockReturnValue({
      origin: 'wss://orca.example',
      hostPublicKeyB64: offer.publicKeyB64,
      headers: { 'X-Token': 'synthetic-secret' }
    })
    const result = await verifyAndRepairRuntimeEnvironmentFromPairingCode(directory, {
      selector: saved.id,
      pairingCode: encodePairingOffer({ ...offer, endpoint: 'wss://other.example' })
    })
    expect(result.ok).toBe(false)
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.write).not.toHaveBeenCalled()
  })
})
