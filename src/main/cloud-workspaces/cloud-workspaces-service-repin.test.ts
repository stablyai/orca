// A grant's read-snapshot signer may replace a pinned one only after its pairing completed.
import { describe, expect, it, vi } from 'vitest'
import { memoryReadPins, type ReaderKeyAccess } from './cloud-read-snapshot-reader'
import { createCloudWorkspacesService } from './cloud-workspaces-service'
import {
  generateTestSigner,
  sealReadSnapshotForTest,
  type TestSigner
} from './read-snapshot-sealer.test-fixture'
import { generateGrantRecipientKey } from './sealed-grant-node'
import { GRANT_ID, sealGrantForTest } from './sealed-grant-sealer.test-fixture'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

const SBX = 'sbx_0123456789abcdef01234567'
const KEY_ID = 'rk_aaaaaaaaaaaaaaaaaaaaaaaa'
const NOW = 1_700_000_000_000
const PAIRING = 'orca://pair?code=forged-or-real'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function setup() {
  const readerKey = generateGrantRecipientKey()
  const access: ReaderKeyAccess = {
    identity: () => 'me',
    load: async () => ({ ok: true, key: readerKey })
  }
  const pins = memoryReadPins()
  const served: { capturedAt: number; signer: TestSigner } = {
    capturedAt: NOW,
    signer: generateTestSigner()
  }
  let grantSigner: string | null = null
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/v1/reader-keys') {
      return json({
        readerKey: {
          id: KEY_ID,
          deviceKind: 'desktop',
          deviceLabel: 't',
          createdAt: 1,
          lastSeenAt: 1
        }
      })
    }
    if (url.pathname.endsWith('/grants') && init?.method === 'POST') {
      const body: unknown = JSON.parse(String(init.body))
      const recipient =
        typeof body === 'object' && body !== null && 'recipientPublicKeyB64' in body
          ? String(body.recipientPublicKeyB64)
          : ''
      return json({
        grant: {
          id: GRANT_ID,
          workspaceId: SBX,
          userId: 'me',
          deviceKind: 'desktop',
          deviceLabel: 't',
          status: 'active',
          createdAt: 1,
          revokedAt: null
        },
        sealed: sealGrantForTest(
          {
            pairingUrl: PAIRING,
            deviceId: 'dev_1',
            scope: 'runtime',
            ...(grantSigner ? { readSignerPublicKeyB64: grantSigner } : {})
          },
          recipient
        )
      })
    }
    if (url.pathname.endsWith('/read-snapshot')) {
      const snapshotId = `snap_${served.capturedAt}`
      return json({
        snapshot: sealReadSnapshotForTest({
          payload: {
            v: 1,
            workspaceId: SBX,
            snapshotId,
            capturedAt: served.capturedAt,
            reason: 'sleep',
            git: null,
            pr: null,
            sessions: []
          },
          workspaceId: SBX,
          snapshotId,
          readerPublicKeyB64: readerKey.publicKeyB64,
          keyId: KEY_ID,
          signer: served.signer
        })
      })
    }
    return json({ error: 'not_found' }, 404)
  })
  const service = createCloudWorkspacesService({
    userDataPath: '/nonexistent-user-data',
    config: { controlPlaneUrl: 'https://cp.example.test', getAccessToken: async () => 'tok' },
    clientId: 'test-client',
    fetch,
    readerKey: access,
    readPins: pins
  })
  return {
    service,
    pins,
    serve: (capturedAt: number, signer: TestSigner) => {
      served.capturedAt = capturedAt
      served.signer = signer
    },
    grantSigns: (signer: TestSigner) => {
      grantSigner = signer.publicKeyB64
    }
  }
}

async function readState(t: ReturnType<typeof setup>): Promise<string> {
  const result = await t.service.readSnapshot(SBX)
  return result.ok ? result.value.state : `error:${result.error}`
}

describe('re-pinning a read-snapshot signer through pairing', () => {
  it('a forged grant that is opened but never paired cannot replace the pinned signer', async () => {
    const t = setup()
    const original = generateTestSigner()
    t.serve(NOW, original)
    expect(await readState(t)).toBe('ready')

    const forged = generateTestSigner()
    t.grantSigns(forged)
    expect((await t.service.openGrant(SBX)).ok).toBe(true)
    expect((await t.pins.get('me', SBX))?.signerPublicKeyB64).toBe(original.publicKeyB64)
    t.serve(NOW + 1, forged)
    expect(await readState(t)).toBe('unverified')
  })

  it('a completed pairing re-pins the signer and keeps the rollback floor', async () => {
    const t = setup()
    t.serve(NOW + 10, generateTestSigner())
    expect(await readState(t)).toBe('ready')

    const rebuilt = generateTestSigner()
    t.grantSigns(rebuilt)
    expect((await t.service.openGrant(SBX)).ok).toBe(true)
    await t.service.confirmPairing(PAIRING)
    expect(await t.pins.get('me', SBX)).toEqual({
      signerPublicKeyB64: rebuilt.publicKeyB64,
      newestCapturedAt: NOW + 10
    })
    t.serve(NOW + 20, rebuilt)
    expect(await readState(t)).toBe('ready')
    t.serve(NOW + 5, rebuilt)
    expect(await readState(t)).toBe('stale')
  })

  it('a pairing that failed (never verified) does not re-pin', async () => {
    const t = setup()
    const original = generateTestSigner()
    t.serve(NOW, original)
    expect(await readState(t)).toBe('ready')

    t.grantSigns(generateTestSigner())
    expect((await t.service.openGrant(SBX)).ok).toBe(true)
    // Some other code was verified; this grant's pairing never completed.
    await t.service.confirmPairing('orca://pair?code=something-else')
    expect((await t.pins.get('me', SBX))?.signerPublicKeyB64).toBe(original.publicKeyB64)
  })

  it('a grant only fills an empty pin, before any read', async () => {
    const t = setup()
    const signer = generateTestSigner()
    t.grantSigns(signer)
    expect((await t.service.openGrant(SBX)).ok).toBe(true)
    expect(await t.pins.get('me', SBX)).toEqual({
      signerPublicKeyB64: signer.publicKeyB64,
      newestCapturedAt: 0
    })
  })
})
