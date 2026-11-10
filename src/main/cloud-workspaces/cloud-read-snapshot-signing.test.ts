import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SealedReadSnapshot } from '../../shared/cloud-workspaces/read-snapshot'
import { createReadPinStore } from './cloud-read-pin-store'
import {
  createReadSnapshotReader,
  type ReaderKeyAccess,
  type ReadPinAccess
} from './cloud-read-snapshot-reader'
import type { ReadSnapshotFetch } from './cloud-workspaces-client'
import { createCloudWorkspacesClient } from './cloud-workspaces-client'
import {
  generateTestSigner,
  sealReadSnapshotForTest,
  type TestSigner
} from './read-snapshot-sealer.test-fixture'
import { generateGrantRecipientKey } from './sealed-grant-node'

const SBX = 'sbx_0123456789abcdef01234567'
const KEY_ID = 'rk_aaaaaaaaaaaaaaaaaaaaaaaa'
const NOW = 1_700_000_000_000

const payload = (capturedAt: number) => ({
  v: 1,
  workspaceId: SBX,
  snapshotId: `snap_${capturedAt}`,
  capturedAt,
  reason: 'sleep',
  git: null,
  pr: null,
  sessions: []
})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'read-pins-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Pins in a JSON file under `dir`, as the app keeps them per profile. */
function filePins(): ReadPinAccess {
  const store = createReadPinStore({ pathFor: (profileId) => join(dir, profileId, 'pins.json') })
  return {
    get: (identity, sandboxId) => store.get('p1', `${identity}\0${sandboxId}`),
    set: (identity, sandboxId, pin) => store.set('p1', `${identity}\0${sandboxId}`, pin)
  }
}

function setup(pins: ReadPinAccess = filePins()) {
  const key = generateGrantRecipientKey()
  const readerKey: ReaderKeyAccess = {
    identity: () => 'me',
    load: async () => ({ ok: true, key })
  }
  let next: { capturedAt: number; signer?: TestSigner; tamper?: boolean } = { capturedAt: NOW }
  const getReadSnapshot = vi.fn(async (): Promise<ReadSnapshotFetch> => {
    const sealed = sealReadSnapshotForTest({
      payload: payload(next.capturedAt),
      workspaceId: SBX,
      snapshotId: `snap_${next.capturedAt}`,
      readerPublicKeyB64: key.publicKeyB64,
      keyId: KEY_ID,
      signer: next.signer
    })
    return { kind: 'sealed', sealed: next.tamper ? tamper(sealed) : sealed }
  })
  const reader = createReadSnapshotReader({
    client: {
      registerReaderKey: async () => ({
        id: KEY_ID,
        deviceKind: 'desktop' as const,
        deviceLabel: 't',
        createdAt: 1,
        lastSeenAt: 1
      }),
      getReadSnapshot,
      deleteReaderKey: async () => {}
    },
    readerKey,
    pins,
    deviceLabel: () => 't'
  })
  return {
    reader,
    serve: (value: typeof next) => {
      next = value
    }
  }
}

/** Flips one ciphertext byte, keeping the signature: what a tampering relay would send. */
function tamper(sealed: SealedReadSnapshot): SealedReadSnapshot {
  const body = Buffer.from(sealed.ciphertextB64, 'base64')
  body[0] = body[0]! ^ 0xff
  return { ...sealed, ciphertextB64: body.toString('base64') }
}

describe('signed read snapshots', () => {
  it('opens a snapshot the workspace signed', async () => {
    const t = setup()
    t.serve({ capturedAt: NOW, signer: generateTestSigner() })
    expect((await t.reader.read(SBX)).state).toBe('ready')
  })

  it('refuses a tampered body before decrypting it', async () => {
    const t = setup()
    t.serve({ capturedAt: NOW, signer: generateTestSigner(), tamper: true })
    expect(await t.reader.read(SBX)).toEqual({ state: 'unverified', reason: 'bad_signature' })
  })

  it('refuses a copy re-signed by another key once the signer is pinned', async () => {
    const t = setup()
    t.serve({ capturedAt: NOW, signer: generateTestSigner() })
    expect((await t.reader.read(SBX)).state).toBe('ready')
    t.serve({ capturedAt: NOW + 1, signer: generateTestSigner() })
    expect(await t.reader.read(SBX)).toEqual({ state: 'unverified', reason: 'signer_changed' })
  })

  it('refuses an unsigned copy once a signer is pinned, but accepts one from an older VM before', async () => {
    const t = setup()
    t.serve({ capturedAt: NOW })
    expect((await t.reader.read(SBX)).state).toBe('ready')
    t.serve({ capturedAt: NOW + 1, signer: generateTestSigner() })
    expect((await t.reader.read(SBX)).state).toBe('ready')
    t.serve({ capturedAt: NOW + 2 })
    expect(await t.reader.read(SBX)).toEqual({ state: 'unverified', reason: 'unsigned' })
  })

  it('keeps the signer and rollback pins across a restart (new reader over the same file)', async () => {
    const signer = generateTestSigner()
    const before = setup()
    before.serve({ capturedAt: NOW + 10, signer })
    expect((await before.reader.read(SBX)).state).toBe('ready')

    const after = setup()
    after.serve({ capturedAt: NOW + 5, signer })
    expect(await after.reader.read(SBX)).toEqual({ state: 'stale' })
    after.serve({ capturedAt: NOW + 20, signer: generateTestSigner() })
    expect(await after.reader.read(SBX)).toEqual({ state: 'unverified', reason: 'signer_changed' })
    after.serve({ capturedAt: NOW + 20, signer })
    expect((await after.reader.read(SBX)).state).toBe('ready')
  })

  it('a pairing (grant) pin replaces the signer, e.g. after the VM disk was replaced', async () => {
    const t = setup()
    t.serve({ capturedAt: NOW, signer: generateTestSigner() })
    expect((await t.reader.read(SBX)).state).toBe('ready')
    const replaced = generateTestSigner()
    await t.reader.pinSigner(SBX, replaced.publicKeyB64)
    t.serve({ capturedAt: NOW + 1, signer: replaced })
    expect((await t.reader.read(SBX)).state).toBe('ready')
    // The rollback floor survives the re-pin.
    t.serve({ capturedAt: NOW - 1, signer: replaced })
    expect(await t.reader.read(SBX)).toEqual({ state: 'stale' })
  })

  it('a grant pin before the first read means only that signer is accepted', async () => {
    const t = setup()
    const signer = generateTestSigner()
    await t.reader.pinSigner(SBX, signer.publicKeyB64)
    t.serve({ capturedAt: NOW, signer: generateTestSigner() })
    expect(await t.reader.read(SBX)).toEqual({ state: 'unverified', reason: 'signer_changed' })
    t.serve({ capturedAt: NOW })
    expect(await t.reader.read(SBX)).toEqual({ state: 'unverified', reason: 'unsigned' })
    t.serve({ capturedAt: NOW, signer })
    expect((await t.reader.read(SBX)).state).toBe('ready')
  })
})

describe('the client keeps the signature', () => {
  it('passes the relayed signature through the wire schema to the reader', async () => {
    const signer = generateTestSigner()
    const key = generateGrantRecipientKey()
    const sealed = sealReadSnapshotForTest({
      payload: payload(NOW),
      workspaceId: SBX,
      snapshotId: `snap_${NOW}`,
      readerPublicKeyB64: key.publicKeyB64,
      keyId: KEY_ID,
      signer
    })
    const client = createCloudWorkspacesClient({
      baseUrl: 'https://cp.example.test',
      getAccessToken: async () => 'tok',
      fetch: vi.fn<typeof globalThis.fetch>(
        async () => new Response(JSON.stringify({ snapshot: sealed }), { status: 200 })
      )
    })
    const fetched = await client.getReadSnapshot(SBX, KEY_ID)
    expect(fetched.kind === 'sealed' && fetched.sealed.signature).toEqual(sealed.signature)
  })
})

describe('createReadPinStore', () => {
  it('clear drops every pin for the profile (sign-out)', async () => {
    const store = createReadPinStore({ pathFor: (profileId) => join(dir, profileId, 'pins.json') })
    await store.set('p1', 'k', { signerPublicKeyB64: 'x', newestCapturedAt: 1 })
    await store.clear('p1')
    expect(await store.get('p1', 'k')).toBeNull()
    const reopened = createReadPinStore({
      pathFor: (profileId) => join(dir, profileId, 'pins.json')
    })
    expect(await reopened.get('p1', 'k')).toBeNull()
  })
})
