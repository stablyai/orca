import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, type Stats } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadWindowsSecurity, type WindowsSecurity } from '../../shared/windows-security-addon'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'

/**
 * What a *successful* harden does to a reader that cannot read.
 *
 * Path hardening writes a protected DACL granting only the SIDs the running process holds. Where
 * the data root came from somewhere else — a relocated `ORCA_USER_DATA_PATH`, a share, a roaming
 * profile, a backup restored under a recreated local account, or a harden whose `/reset` landed
 * and whose grant did not — the file ends up granting a SID this process does not have. It then
 * reads as `EPERM` while its *directory* stays writable, because file hardening is synchronous on
 * the write path and directory hardening is fire-and-forget.
 *
 * Every store below used to treat any read failure as "malformed — regenerate", and the
 * regeneration succeeds: `renameSync` over an unreadable file needs `FILE_DELETE_CHILD` on the
 * parent, not `DELETE` on the file. So the healing path destroyed the thing it could not read.
 * Before hardening actually applied, this failed open — the file was simply readable.
 *
 * These assert the file is still the same, untouched inode afterwards. Runs only on win32, where a
 * DACL is the mechanism; skipped elsewhere.
 */

/** Whether a DACL that omits this token actually denies it a read. */
function readDenied(filePath: string): boolean {
  try {
    readFileSync(filePath, 'utf8')
    return false
  } catch (error) {
    return /^(?:EPERM|EACCES)$/.test((error as NodeJS.ErrnoException).code ?? '')
  }
}

/**
 * An elevated token logged in as the built-in Administrator reads straight through a DACL that
 * grants it nothing, so on such a host every assertion here would pass while proving nothing.
 * Probe once and skip rather than assert vacuously -- the same trade the ACL suite makes for its
 * unelevated-only case. `isUnreadableError` has its own unit tests on every platform; this suite
 * carries the stores' refusal wherever a denial is actually reproducible.
 */
function canDenyReads(): boolean {
  if (process.platform !== 'win32') {
    return false
  }
  const probeRoot = mkdtempSync(join(tmpdir(), 'orca-deny-probe-'))
  const probe = join(probeRoot, 'probe.json')
  try {
    writeFileSync(probe, '{}')
    lockAgainstThisProcess(probe)
    return readDenied(probe)
  } finally {
    removeTreeSync(probeRoot)
  }
}

/**
 * BUILTIN\Guests: a real, always-resolvable group that no interactive token is a member of.
 * `S-1-5-32-544` looks foreign only until the suite meets a host that is elevated AND logged
 * in as the built-in Administrator -- a CI runner -- where it grants the reader full control
 * and every assertion below goes vacuous.
 */
const FOREIGN_SID = 'S-1-5-32-546'

function addon(): WindowsSecurity['addon'] {
  const loaded = loadWindowsSecurity()
  if ('error' in loaded) {
    throw new Error(`the windows-security addon did not load: ${loaded.error}`)
  }
  return loaded.addon
}

/**
 * Protected, so nothing inherited from %TEMP% keeps the file readable. The OWNER RIGHTS rule
 * withdraws the owner's implicit READ_CONTROL and WRITE_DAC: this process created the file, but
 * the case being modelled is one owned by another account (a restored backup, a share), which
 * Orca's read-path hardening cannot simply take back. Its parent stays ours, so it still deletes.
 */
function lockAgainstThisProcess(filePath: string): void {
  addon().setDaclSddl(filePath, `D:P(A;;FA;;;${FOREIGN_SID})(A;;0x100000;;;OW)`)
}

/** The on-disk state a successful harden leaves for a SID this process does not hold. */
function makeUnreadable(filePath: string): Stats {
  lockAgainstThisProcess(filePath)
  expect(readDenied(filePath), 'fixture should be unreadable').toBe(true)
  return statSync(filePath)
}

/** The same file, never replaced: a regenerated one would be a new, readable inode. */
function expectUntouched(filePath: string, before: Stats): void {
  const after = statSync(filePath)
  expect(after.ino).toBe(before.ino)
  expect(after.size).toBe(before.size)
  expect(readDenied(filePath)).toBe(true)
}

const describeOnWindows = process.platform === 'win32' && canDenyReads() ? describe : describe.skip

describeOnWindows('a secure store that exists but cannot be read', () => {
  let root: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-unreadable-'))
  })

  afterAll(() => {
    removeTreeSync(root)
  })

  it('does not regenerate the E2EE keypair, which would un-pair every device', async () => {
    const { loadOrCreateE2EEKeypair } = await import('./e2ee-keypair')
    const { E2EE_KEYPAIR_FILENAME } = await import('./mobile-pairing-files')
    const dir = join(root, 'e2ee')
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, E2EE_KEYPAIR_FILENAME)
    const original = JSON.stringify({
      v: 1,
      publicKeyB64: Buffer.alloc(32, 7).toString('base64'),
      secretKeyB64: Buffer.alloc(32, 9).toString('base64')
    })
    writeFileSync(filePath, original)
    const locked = makeUnreadable(filePath)

    expect(() => loadOrCreateE2EEKeypair(dir)).toThrow(/Refusing to (regenerate|overwrite)/)

    // The point: the secret key is still the one every paired phone derived its shared secret from.
    expectUntouched(filePath, locked)
  })

  it('does not erase the device registry, which would revoke every paired token', async () => {
    const { DeviceRegistry } = await import('./device-registry')
    const { DEVICE_REGISTRY_FILENAME } = await import('./mobile-pairing-files')
    const dir = join(root, 'devices')
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, DEVICE_REGISTRY_FILENAME)
    const original = JSON.stringify([
      {
        deviceId: 'device-1',
        name: 'Phone',
        token: 'bearer-token-that-must-survive',
        scope: 'mobile',
        pairedAt: 1,
        lastSeenAt: 2
      }
    ])
    writeFileSync(filePath, original)
    const locked = makeUnreadable(filePath)

    const registry = new DeviceRegistry(dir)
    // Any mutator reaches save(); it must refuse rather than write the empty list it loaded.
    expect(() => registry.addDevice('Another phone', 'mobile')).toThrow(
      /Refusing to (regenerate|overwrite)/
    )

    expectUntouched(filePath, locked)
  })

  it('does not blank the plugin secret vault on write', async () => {
    vi.doMock('electron', () => ({
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(`enc:${value}`),
        decryptString: (buffer: Buffer) => buffer.toString().replace(/^enc:/, '')
      }
    }))
    const { PluginSecretsStore } = await import('./../plugins/plugin-secrets-store')
    const dir = join(root, 'plugin-secrets')
    mkdirSync(dir, { recursive: true })
    const store = new PluginSecretsStore(dir, 'publisher.plugin')
    // Reach the path the store computes rather than restating its layout here.
    const filePath = (store as unknown as { filePath: string }).filePath
    mkdirSync(join(filePath, '..'), { recursive: true })
    const original = JSON.stringify({
      version: 1,
      format: 'electron-safe-storage-v1',
      ciphertexts: { existing: Buffer.from('enc:keep-me').toString('base64') }
    })
    writeFileSync(filePath, original)
    const locked = makeUnreadable(filePath)

    expect(store.set('added', 'value')).toEqual({ ok: false, error: expect.any(String) })
    store.delete('existing')

    expectUntouched(filePath, locked)
    vi.doUnmock('electron')
  })
  it('does not blank the plugin KV store on write', async () => {
    const { PluginKvStore } = await import('./../plugins/plugin-storage-store')
    const dir = join(root, 'plugin-kv')
    mkdirSync(dir, { recursive: true })
    const store = new PluginKvStore(dir, 'publisher.plugin', 'storage.json')
    const filePath = (store as unknown as { filePath: string }).filePath
    mkdirSync(join(filePath, '..'), { recursive: true })
    const original = JSON.stringify({ keep: 'me' })
    writeFileSync(filePath, original)
    const locked = makeUnreadable(filePath)

    expect(store.set('added', 'value')).toEqual({ ok: false, error: expect.any(String) })
    store.delete('keep')

    expectUntouched(filePath, locked)
  })

  it('does not drop pending relay revocations', async () => {
    const { RelayRevokeOutbox } = await import('./mobile-cloud-relay/relay-revoke-outbox')
    const dir = join(root, 'relay')
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, 'mobile-relay-revoke-outbox.json')
    const original = JSON.stringify([
      {
        relayHostId: 'host-1',
        relayDeviceId: 'device-1',
        ownerIdentityKey: 'owner-1',
        reqId: 'req-1',
        createdAt: 1
      }
    ])
    writeFileSync(filePath, original)
    const locked = makeUnreadable(filePath)

    const outbox = new RelayRevokeOutbox(dir)
    expect(() =>
      outbox.enqueue({
        relayHostId: 'host-2',
        relayDeviceId: 'device-2',
        ownerIdentityKey: 'owner-2'
      })
    ).toThrow(/Refusing to (regenerate|overwrite)/)

    expectUntouched(filePath, locked)
  })

  /**
   * The one site that *deletes* rather than overwrites: a refresh failure plus an unreadable
   * session used to fall past the `status === 'found'` guard into `clearOrcaCloudSession`.
   */
  it('does not delete the account session it could not read', async () => {
    vi.doMock('electron', () => ({
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(value),
        decryptString: (buffer: Buffer) => buffer.toString()
      }
    }))
    const { readOrcaCloudSession, getOrcaCloudSessionPath } =
      await import('./../orca-profiles/profile-cloud-session-store')
    const dir = join(root, 'profiles')
    mkdirSync(dir, { recursive: true })
    const filePath = getOrcaCloudSessionPath('profile-1', dir)
    mkdirSync(join(filePath, '..'), { recursive: true })
    const original = JSON.stringify({ version: 1, format: 'dev-plaintext-v1', savedAt: 1 })
    writeFileSync(filePath, original)
    const locked = makeUnreadable(filePath)

    // The status the delete path keys off: `unreadable`, never `decrypt-failed`.
    expect(readOrcaCloudSession('profile-1', dir).status).toBe('unreadable')

    expectUntouched(filePath, locked)
    vi.doUnmock('electron')
  })
})
