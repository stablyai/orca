import { describe, expect, it, vi } from 'vitest'
import { CloudWorkspacesError, type ReadSnapshotFetch } from './cloud-workspaces-client'
import {
  createReadSnapshotReader,
  READER_KEY_REFRESH_MS,
  type ReaderKeyAccess
} from './cloud-read-snapshot-reader'
import { generateGrantRecipientKey } from './sealed-grant-node'
import { sealReadSnapshotForTest } from './read-snapshot-sealer.test-fixture'

const SBX = 'sbx_0123456789abcdef01234567'
const KEY_A = 'rk_aaaaaaaaaaaaaaaaaaaaaaaa'
const KEY_B = 'rk_bbbbbbbbbbbbbbbbbbbbbbbb'

const payload = {
  v: 1,
  workspaceId: SBX,
  snapshotId: 'snap_1',
  capturedAt: 1_700_000_000_000,
  reason: 'sleep',
  git: {
    branch: 'main',
    head: 'abc1234',
    changes: [{ path: 'src/a.ts', status: 'modified', area: 'unstaged', added: 3, removed: 1 }],
    changeCount: 1,
    added: 3,
    removed: 1,
    commits: [{ id: 'abc1234', subject: 'Fix', author: 'Ada', at: 1 }]
  },
  pr: {
    number: 42,
    title: 'Fix it',
    state: 'open',
    url: 'https://github.com/acme/web/pull/42',
    checksStatus: 'success',
    checksSummary: '3/3 passed'
  },
  sessions: [
    {
      sessionId: 's1',
      agent: 'claude',
      title: 'Fix the bug',
      status: 'idle',
      turnOutcome: 'done',
      updatedAt: 2,
      messages: [{ itemId: 'm1', role: 'assistant', text: 'Done.', at: 2 }],
      truncated: false
    }
  ]
}

function setup(options: { identity?: string | null; keychain?: boolean } = {}) {
  const key = generateGrantRecipientKey()
  let identity: string | null = options.identity === undefined ? 'me' : options.identity
  const readerKey: ReaderKeyAccess = {
    identity: () => identity,
    load: () =>
      options.keychain === false
        ? { ok: false, reason: 'keychain_unavailable', message: 'no keychain' }
        : { ok: true, key },
    peek: () => (options.keychain === false ? null : key)
  }
  let now = 10_000
  const ids = [KEY_A]
  const registerReaderKey = vi.fn(async () => ({
    id: ids[0]!,
    deviceKind: 'desktop' as const,
    deviceLabel: 'test',
    createdAt: 1,
    lastSeenAt: 1
  }))
  let capturedAt = payload.capturedAt
  const getReadSnapshot = vi.fn(async (_id: string, keyId: string): Promise<ReadSnapshotFetch> => ({
    kind: 'sealed',
    sealed: sealReadSnapshotForTest({
      payload: { ...payload, capturedAt },
      workspaceId: SBX,
      snapshotId: 'snap_1',
      readerPublicKeyB64: key.publicKeyB64,
      keyId,
      storedAt: 5
    })
  }))
  const deleteReaderKey = vi.fn(async (_keyId: string, _timeoutMs?: number) => {})
  const reader = createReadSnapshotReader({
    client: { registerReaderKey, getReadSnapshot, deleteReaderKey },
    readerKey,
    deviceLabel: () => 'test-mac',
    now: () => now
  })
  return {
    reader,
    key,
    ids,
    registerReaderKey,
    getReadSnapshot,
    deleteReaderKey,
    setCapturedAt: (at: number) => {
      capturedAt = at
    },
    tick: (ms: number) => {
      now += ms
    },
    setIdentity: (next: string | null) => {
      identity = next
    }
  }
}

describe('createReadSnapshotReader', () => {
  it('registers the key, then opens a snapshot sealed to it (independent sealer roundtrip)', async () => {
    const t = setup()
    const result = await t.reader.read(SBX)
    expect(t.registerReaderKey).toHaveBeenCalledWith({
      publicKeyB64: t.key.publicKeyB64,
      deviceLabel: 'test-mac',
      deviceKind: 'desktop'
    })
    expect(t.getReadSnapshot).toHaveBeenCalledWith(SBX, KEY_A)
    expect(result.state).toBe('ready')
    if (result.state !== 'ready') {
      return
    }
    expect(result.storedAt).toBe(5)
    expect(result.snapshot.capturedAt).toBe(payload.capturedAt)
    expect(result.snapshot.pr?.number).toBe(42)
    expect(result.snapshot.git?.changes[0]).toMatchObject({ path: 'src/a.ts', added: 3 })
    expect(result.snapshot.sessions[0]).toMatchObject({ agent: 'claude', status: 'idle' })
  })

  it('reuses the registration for 6 h, then refreshes it', async () => {
    const t = setup()
    await t.reader.register()
    await t.reader.read(SBX)
    expect(t.registerReaderKey).toHaveBeenCalledTimes(1)
    t.tick(READER_KEY_REFRESH_MS)
    await t.reader.read(SBX)
    expect(t.registerReaderKey).toHaveBeenCalledTimes(2)
  })

  it('shares one registration between concurrent callers', async () => {
    const t = setup()
    await Promise.all([t.reader.register(), t.reader.read(SBX), t.reader.read(SBX)])
    expect(t.registerReaderKey).toHaveBeenCalledTimes(1)
  })

  it('registers again after an account switch', async () => {
    const t = setup()
    await t.reader.read(SBX)
    t.setIdentity('someone-else')
    await t.reader.read(SBX)
    expect(t.registerReaderKey).toHaveBeenCalledTimes(2)
  })

  it.each(['no_snapshot', 'not_found'] as const)('reports %s as a state', async (kind) => {
    const t = setup()
    t.getReadSnapshot.mockResolvedValueOnce({ kind })
    expect(await t.reader.read(SBX)).toEqual({ state: kind })
  })

  it('reports not_sealed_for_key when the snapshot predates a freshly registered key', async () => {
    const t = setup()
    t.getReadSnapshot.mockResolvedValueOnce({ kind: 'not_sealed_for_key' })
    expect(await t.reader.read(SBX)).toEqual({ state: 'not_sealed_for_key' })
    expect(t.registerReaderKey).toHaveBeenCalledTimes(1)
  })

  it('never re-registers on not_sealed_for_key (the snapshot just predates the key)', async () => {
    const t = setup()
    await t.reader.register()
    t.ids[0] = KEY_B
    t.getReadSnapshot.mockResolvedValueOnce({ kind: 'not_sealed_for_key' })
    expect(await t.reader.read(SBX)).toEqual({ state: 'not_sealed_for_key' })
    expect(t.registerReaderKey).toHaveBeenCalledTimes(1)
    expect(t.getReadSnapshot).toHaveBeenCalledTimes(1)
  })

  it('re-registers at most once on invalid_request', async () => {
    const t = setup()
    await t.reader.register()
    t.getReadSnapshot
      .mockRejectedValueOnce(new CloudWorkspacesError(400, 'invalid_request'))
      .mockRejectedValueOnce(new CloudWorkspacesError(400, 'invalid_request'))
    await expect(t.reader.read(SBX)).rejects.toMatchObject({ code: 'invalid_request' })
    expect(t.registerReaderKey).toHaveBeenCalledTimes(2)
    expect(t.getReadSnapshot).toHaveBeenCalledTimes(2)
  })

  it('refuses a snapshot older than one already shown (rollback pin), per workspace and account', async () => {
    const t = setup()
    t.setCapturedAt(2_000)
    expect((await t.reader.read(SBX)).state).toBe('ready')
    // The same snapshot again is fine; a newer one moves the pin.
    expect((await t.reader.read(SBX)).state).toBe('ready')
    t.setCapturedAt(3_000)
    expect((await t.reader.read(SBX)).state).toBe('ready')
    t.setCapturedAt(2_500)
    expect(await t.reader.read(SBX)).toEqual({ state: 'stale' })
    // Another account on this computer has its own pin.
    t.setIdentity('someone-else')
    expect((await t.reader.read(SBX)).state).toBe('ready')
  })

  it('revokes the registered key server-side on sign-out', async () => {
    const t = setup()
    await t.reader.register()
    await t.reader.revoke(1_000)
    expect(t.deleteReaderKey).toHaveBeenCalledWith(KEY_A, 1_000)
    expect(t.registerReaderKey).toHaveBeenCalledTimes(1)
  })

  it('learns the key id before revoking when this run never registered', async () => {
    const t = setup()
    await t.reader.revoke(1_000)
    expect(t.registerReaderKey).toHaveBeenCalledTimes(1)
    expect(t.deleteReaderKey).toHaveBeenCalledWith(KEY_A, 1_000)
  })

  it('revokes nothing without a key or when signed out', async () => {
    await setup({ keychain: false }).reader.revoke(1_000)
    const signedOut = setup({ identity: null })
    await signedOut.reader.revoke(1_000)
    expect(signedOut.deleteReaderKey).not.toHaveBeenCalled()
    expect(signedOut.registerReaderKey).not.toHaveBeenCalled()
  })

  it('re-registers on invalid_request for a remembered key id', async () => {
    const t = setup()
    await t.reader.register()
    t.ids[0] = KEY_B
    t.getReadSnapshot.mockRejectedValueOnce(new CloudWorkspacesError(400, 'invalid_request'))
    expect((await t.reader.read(SBX)).state).toBe('ready')
    expect(t.getReadSnapshot).toHaveBeenLastCalledWith(SBX, KEY_B)
  })

  it('is off with a clear reason without an OS keychain', async () => {
    const t = setup({ keychain: false })
    expect(await t.reader.read(SBX)).toEqual({
      state: 'unavailable',
      reason: 'keychain_unavailable',
      message: 'no keychain'
    })
    expect(t.registerReaderKey).not.toHaveBeenCalled()
  })

  it('refuses when signed out', async () => {
    const t = setup({ identity: null })
    await expect(t.reader.read(SBX)).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('turns a snapshot sealed to another key into snapshot_unreadable', async () => {
    const t = setup()
    const other = generateGrantRecipientKey()
    t.getReadSnapshot.mockResolvedValueOnce({
      kind: 'sealed',
      sealed: sealReadSnapshotForTest({
        payload,
        workspaceId: SBX,
        snapshotId: 'snap_1',
        readerPublicKeyB64: other.publicKeyB64,
        keyId: KEY_A
      })
    })
    await expect(t.reader.read(SBX)).rejects.toMatchObject({
      code: 'snapshot_unreadable',
      reason: 'decrypt_failed'
    })
  })

  it('refuses a snapshot of another workspace', async () => {
    const t = setup()
    const sealed = sealReadSnapshotForTest({
      payload: { ...payload, workspaceId: 'sbx_ffffffffffffffffffffffff' },
      workspaceId: 'sbx_ffffffffffffffffffffffff',
      snapshotId: 'snap_1',
      readerPublicKeyB64: t.key.publicKeyB64,
      keyId: KEY_A
    })
    t.getReadSnapshot.mockResolvedValueOnce({ kind: 'sealed', sealed })
    await expect(t.reader.read(SBX)).rejects.toMatchObject({ reason: 'wrong_workspace' })
  })
})
