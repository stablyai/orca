import {
  createCipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes
} from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }))
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  getItemAsync: async (key: string) => store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void store.set(key, value),
  deleteItemAsync: async (key: string) => void store.delete(key)
}))
vi.mock('./cloud-device-identity', () => ({
  loadCloudDeviceIdentity: async () => ({
    publicKeyB64: 'x',
    secretKey: new Uint8Array(64),
    enrollment: {
      controlPlaneUrl: 'https://cloud.test',
      deviceSessionId: 'ds_1',
      label: 'Neil’s iPhone',
      enrolledAt: 1
    }
  })
}))

import type { SealedReadSnapshot } from '../../../src/shared/cloud-workspaces/read-snapshot'
import type { CloudControlPlane } from './cloud-control-plane-request'
import {
  CLOUD_READER_KEY_REFRESH_MS,
  ensureCloudReaderKey,
  readCloudWorkspaceSnapshot,
  resetCloudReadSnapshotPins
} from './cloud-read-snapshot'
import { loadCloudReaderKey } from './cloud-reader-key'

// Seals exactly as the header of src/shared/cloud-workspaces/read-snapshot.ts says the VM does.
function sealLikeVm(args: {
  readerPublicKeyB64: string
  keyId: string
  workspaceId: string
  snapshotId: string
  payload: unknown
}): SealedReadSnapshot {
  const dek = randomBytes(32)
  const nonce = randomBytes(12)
  const body = createCipheriv('aes-256-gcm', dek, nonce)
  body.setAAD(Buffer.from(`orca-cloud-read-v1:${args.workspaceId}:${args.snapshotId}`))
  const ciphertext = Buffer.concat([
    body.update(JSON.stringify(args.payload), 'utf8'),
    body.final(),
    body.getAuthTag()
  ])
  const readerPublic = Buffer.from(args.readerPublicKeyB64, 'base64')
  const eph = generateKeyPairSync('x25519')
  const ephRaw = Buffer.from(eph.publicKey.export({ format: 'jwk' }).x!, 'base64url')
  const shared = diffieHellman({
    privateKey: eph.privateKey,
    publicKey: createPublicKey({
      key: { kty: 'OKP', crv: 'X25519', x: readerPublic.toString('base64url') },
      format: 'jwk'
    })
  })
  const kek = Buffer.from(
    hkdfSync('sha256', shared, Buffer.concat([ephRaw, readerPublic]), 'orca-cloud-read-wrap-v1', 32)
  )
  const wrapNonce = randomBytes(12)
  const wrap = createCipheriv('aes-256-gcm', kek, wrapNonce)
  wrap.setAAD(
    Buffer.from(`orca-cloud-read-wrap-v1:${args.workspaceId}:${args.snapshotId}:${args.keyId}`)
  )
  const wrapped = Buffer.concat([wrap.update(dek), wrap.final(), wrap.getAuthTag()])
  return {
    v: 1,
    snapshotId: args.snapshotId,
    workspaceId: args.workspaceId,
    storedAt: 2,
    nonceB64: nonce.toString('base64'),
    ciphertextB64: ciphertext.toString('base64'),
    recipient: {
      keyId: args.keyId,
      ephemeralPublicKeyB64: ephRaw.toString('base64'),
      nonceB64: wrapNonce.toString('base64'),
      wrappedKeyB64: wrapped.toString('base64')
    }
  }
}

const PAYLOAD = {
  v: 1,
  workspaceId: 'sbx_1',
  snapshotId: 'snap_1',
  capturedAt: 1_700_000_000_000,
  reason: 'sleep',
  pr: {
    number: 42,
    title: 'Fix login',
    state: 'open',
    url: 'https://github.com/o/r/pull/42',
    checksStatus: 'success',
    checksSummary: null
  },
  git: { branch: 'fix-login', changes: [{ path: 'a.ts', added: 3, removed: 1 }], changeCount: 1 },
  sessions: [
    {
      sessionId: 's1',
      agent: 'claude',
      title: 'Login bug',
      status: 'idle',
      turnOutcome: 'completed',
      messages: [
        { itemId: 'm1', role: 'user', text: 'fix it', at: 1 },
        { itemId: 'm2', role: 'assistant', text: '**Done**', at: 2 }
      ]
    }
  ]
}

type Call = { method: string; url: string; body: unknown }

function fakePlane(handle: (call: Call) => { status: number; body: unknown }): {
  plane: CloudControlPlane
  calls: Call[]
} {
  const calls: Call[] = []
  const fakeFetch: typeof fetch = async (input, init) => {
    const call = {
      method: init?.method ?? 'GET',
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    }
    calls.push(call)
    const reply = handle(call)
    return new Response(JSON.stringify(reply.body), { status: reply.status })
  }
  const plane: CloudControlPlane = {
    baseUrl: 'https://cloud.test',
    token: () => 'tok',
    fetch: fakeFetch
  }
  return { plane, calls }
}

const registered = (id = 'rk_aaaaaaaaaaaaaaaaaaaaaaaa') => ({
  status: 200,
  body: {
    readerKey: { id, deviceKind: 'mobile', deviceLabel: 'x', createdAt: 1, lastSeenAt: 1 }
  }
})

beforeEach(() => {
  store.clear()
  resetCloudReadSnapshotPins()
})

describe('ensureCloudReaderKey', () => {
  it('registers once as a mobile key, then only again after 6 h or when forced', async () => {
    let clock = 1_000
    const now = () => clock
    const { plane, calls } = fakePlane(() => registered())
    const first = await ensureCloudReaderKey(plane, { now })
    const key = await loadCloudReaderKey('ds_1')
    expect(first?.keyId).toBe('rk_aaaaaaaaaaaaaaaaaaaaaaaa')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      url: 'https://cloud.test/v1/reader-keys',
      body: { publicKeyB64: key.publicKeyB64, deviceLabel: 'Neil’s iPhone', deviceKind: 'mobile' }
    })
    await ensureCloudReaderKey(plane, { now })
    expect(calls).toHaveLength(1)
    clock += CLOUD_READER_KEY_REFRESH_MS
    await ensureCloudReaderKey(plane, { now })
    expect(calls).toHaveLength(2)
    await ensureCloudReaderKey(plane, { now, force: true })
    expect(calls).toHaveLength(3)
  })
})

describe('readCloudWorkspaceSnapshot', () => {
  it('opens a snapshot the VM sealed to this phone (node:crypto seal, Hermes primitives open)', async () => {
    const key = await loadCloudReaderKey('ds_1')
    const keyId = 'rk_bbbbbbbbbbbbbbbbbbbbbbbb'
    const sealed = sealLikeVm({
      readerPublicKeyB64: key.publicKeyB64,
      keyId,
      workspaceId: 'sbx_1',
      snapshotId: 'snap_1',
      payload: PAYLOAD
    })
    const { plane, calls } = fakePlane((call) =>
      call.method === 'PUT' ? registered(keyId) : { status: 200, body: { snapshot: sealed } }
    )
    const result = await readCloudWorkspaceSnapshot(plane, 'sbx_1')
    expect(calls[1]?.url).toBe(
      `https://cloud.test/v1/team/workspaces/sbx_1/read-snapshot?keyId=${keyId}`
    )
    expect(calls.some((call) => /wake/.test(call.url))).toBe(false)
    expect(result.state).toBe('ready')
    if (result.state !== 'ready') {
      return
    }
    expect(result.snapshot.capturedAt).toBe(PAYLOAD.capturedAt)
    expect(result.snapshot.pr?.number).toBe(42)
    expect(result.snapshot.git?.branch).toBe('fix-login')
    expect(result.snapshot.sessions[0]?.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('refuses a snapshot sealed for another workspace', async () => {
    const key = await loadCloudReaderKey('ds_1')
    const sealed = sealLikeVm({
      readerPublicKeyB64: key.publicKeyB64,
      keyId: 'rk_111111111111111111111111',
      workspaceId: 'sbx_other',
      snapshotId: 'snap_1',
      payload: { ...PAYLOAD, workspaceId: 'sbx_other' }
    })
    const { plane } = fakePlane((call) =>
      call.method === 'PUT'
        ? registered('rk_111111111111111111111111')
        : { status: 200, body: { snapshot: sealed } }
    )
    const result = await readCloudWorkspaceSnapshot(plane, 'sbx_1')
    expect(result.state).toBe('error')
  })

  it('fails closed when the wrapped key is for another key id', async () => {
    const key = await loadCloudReaderKey('ds_1')
    const sealed = sealLikeVm({
      readerPublicKeyB64: key.publicKeyB64,
      keyId: 'rk_111111111111111111111111',
      workspaceId: 'sbx_1',
      snapshotId: 'snap_1',
      payload: PAYLOAD
    })
    sealed.recipient.keyId = 'rk_222222222222222222222222'
    const { plane } = fakePlane((call) =>
      call.method === 'PUT'
        ? registered('rk_222222222222222222222222')
        : { status: 200, body: { snapshot: sealed } }
    )
    const result = await readCloudWorkspaceSnapshot(plane, 'sbx_1')
    expect(result).toMatchObject({ state: 'error', error: { code: 'decrypt_failed' } })
  })

  it.each(['no_snapshot', 'not_sealed_for_key', 'not_found'] as const)(
    'maps 404 %s to its state',
    async (code) => {
      const { plane } = fakePlane((call) =>
        call.method === 'PUT' ? registered() : { status: 404, body: { error: code } }
      )
      await expect(readCloudWorkspaceSnapshot(plane, 'sbx_1')).resolves.toEqual({ state: code })
    }
  )

  it('does not renew the key on not_sealed_for_key', async () => {
    const { plane, calls } = fakePlane((call) =>
      call.method === 'PUT' ? registered() : { status: 404, body: { error: 'not_sealed_for_key' } }
    )
    await readCloudWorkspaceSnapshot(plane, 'sbx_1')
    expect(calls.map((c) => c.method)).toEqual(['PUT', 'GET'])
  })

  it('refuses a snapshot older than one already shown for the workspace (rollback pin)', async () => {
    const key = await loadCloudReaderKey('ds_1')
    const keyId = `rk_${'c'.repeat(24)}`
    const seal = (snapshotId: string, capturedAt: number) =>
      sealLikeVm({
        readerPublicKeyB64: key.publicKeyB64,
        keyId,
        workspaceId: 'sbx_pin',
        snapshotId,
        payload: { ...PAYLOAD, workspaceId: 'sbx_pin', snapshotId, capturedAt }
      })
    let next = seal('snap_new', 2_000)
    const { plane } = fakePlane((call) =>
      call.method === 'PUT' ? registered(keyId) : { status: 200, body: { snapshot: next } }
    )
    expect((await readCloudWorkspaceSnapshot(plane, 'sbx_pin')).state).toBe('ready')
    next = seal('snap_old', 1_000)
    expect(await readCloudWorkspaceSnapshot(plane, 'sbx_pin')).toMatchObject({
      state: 'error',
      error: { name: 'CloudReadSnapshotRollbackError', capturedAt: 1_000, newestShownAt: 2_000 }
    })
    next = seal('snap_same', 2_000)
    expect((await readCloudWorkspaceSnapshot(plane, 'sbx_pin')).state).toBe('ready')
    next = seal('snap_newer', 3_000)
    expect((await readCloudWorkspaceSnapshot(plane, 'sbx_pin')).state).toBe('ready')
    next = seal('snap_same', 2_000)
    expect((await readCloudWorkspaceSnapshot(plane, 'sbx_pin')).state).toBe('error')
  })

  it('re-registers once on invalid_request and asks again', async () => {
    let gets = 0
    const { plane, calls } = fakePlane((call) => {
      if (call.method === 'PUT') {
        return registered(
          gets === 0 ? 'rk_000000000000000000000000' : 'rk_ffffffffffffffffffffffff'
        )
      }
      gets += 1
      return gets === 1
        ? { status: 400, body: { error: 'invalid_request' } }
        : { status: 404, body: { error: 'no_snapshot' } }
    })
    await expect(readCloudWorkspaceSnapshot(plane, 'sbx_1')).resolves.toEqual({
      state: 'no_snapshot'
    })
    expect(calls.map((c) => c.method)).toEqual(['PUT', 'GET', 'PUT', 'GET'])
    expect(calls[3]?.url).toContain('keyId=rk_ffffffffffffffffffffffff')
  })

  it('returns a 401 as an error carrying the status, for the caller to forget the session', async () => {
    const { plane } = fakePlane((call) =>
      call.method === 'PUT' ? registered() : { status: 401, body: { error: 'unauthorized' } }
    )
    const result = await readCloudWorkspaceSnapshot(plane, 'sbx_1')
    expect(result).toMatchObject({ state: 'error', error: { status: 401 } })
  })

  it('returns a malformed reply as an error', async () => {
    const { plane } = fakePlane((call) =>
      call.method === 'PUT' ? registered() : { status: 200, body: { snapshot: { v: 2 } } }
    )
    expect((await readCloudWorkspaceSnapshot(plane, 'sbx_1')).state).toBe('error')
  })
})
