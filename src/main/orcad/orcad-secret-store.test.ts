import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { credentialDecryptionMessage } from '../../shared/integration-credential-errors'
import { classifyUnenvelopedCredential } from '../../shared/secret-at-rest-protection'
import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secret-store'
import { readStoredCredentialToken, writeEncryptedCredential } from '../integration-credential-file'
import type { OrcadLegacyKeyLookup, OrcadLegacyKeyringReader } from './orcad-legacy-keyring-key'
import { orcadSecretStateFileName } from './orcad-secret-key-record'
import {
  deriveOrcadSealingKey,
  orcadSealingKeyCheck,
  sealOrcadSecret
} from './orcad-secret-sealing'
import { createOrcadSecretStore } from './orcad-secret-store'

const MACHINE_A = '0123456789abcdef0123456789abcdef'
const MACHINE_B = 'fedcba9876543210fedcba9876543210'
const STATE_A = orcadSecretStateFileName(MACHINE_A)

/** A keyring an older build wrote; read-only, like the real migration reader. */
function fakeLegacyKeyring(answer: OrcadLegacyKeyLookup) {
  const reads: string[] = []
  const read: OrcadLegacyKeyringReader = async (account) => {
    reads.push(account)
    return answer
  }
  return { read, reads }
}

describe('createOrcadSecretStore', () => {
  let keyDir: string

  beforeEach(() => {
    keyDir = mkdtempSync(join(tmpdir(), 'orcad-secret-store-'))
  })

  afterEach(() => {
    _resetSecretStoreForTests()
    rmSync(keyDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const prepare = async (
    options: {
      legacyKeyring?: OrcadLegacyKeyringReader | null
      machine?: string | null
      env?: NodeJS.ProcessEnv
      log?: (message: string) => void
    } = {}
  ) => {
    const store = createOrcadSecretStore(options.log ?? (() => {}))
    const ready = await store.prepare({
      keyDir,
      platform: 'linux',
      env: options.env ?? {},
      legacyKeyring: options.legacyKeyring ?? null,
      machineIdentity: () => (options.machine === undefined ? MACHINE_A : options.machine),
      isTemporaryKeyDir: () => false
    })
    return { store, ready }
  }

  /** A host an hourly build set up: its record points at a key in the OS keyring. */
  const legacyKeyringHost = () => {
    const master = randomBytes(32)
    const key = deriveOrcadSealingKey(master, '')
    const record = {
      version: 1,
      backend: 'os-keyring',
      account: 'home-0123456789abcdef',
      check: orcadSealingKeyCheck(key)
    }
    writeFileSync(join(keyDir, STATE_A), JSON.stringify(record), {
      mode: 0o600
    })
    return {
      encodedKey: master.toString('base64'),
      sealed: sealOrcadSecret(key, 'lin_api_secret')
    }
  }

  it('seals with a host-bound profile key when no keyring is reachable', async () => {
    const { store, ready } = await prepare()
    expect(ready).toBe(true)
    expect(store.isEncryptionAvailable()).toBe(true)
    const sealed = store.encryptString('lin_api_secret')
    expect(sealed.includes(Buffer.from('lin_api_secret'))).toBe(false)
    expect(classifyUnenvelopedCredential(sealed)).toBe('sealed')
    expect(store.decryptString(sealed)).toBe('lin_api_secret')
    expect(store.describeProtectionGap()).toContain('mixed with this machine ID')

    const statePath = join(keyDir, STATE_A)
    if (process.platform !== 'win32') {
      expect(statSync(statePath).mode & 0o777).toBe(0o600)
    }
    const reopened = (await prepare()).store
    expect(reopened.decryptString(sealed)).toBe('lin_api_secret')
  })

  it('gives another machine sharing the home its own key, leaving this one intact', async () => {
    const sealed = (await prepare()).store.encryptString('lin_api_secret')
    const stateBefore = readFileSync(join(keyDir, STATE_A))

    const { store, ready } = await prepare({ machine: MACHINE_B })
    expect(ready).toBe(true)
    expect(() => store.decryptString(sealed)).toThrow()
    expect(readFileSync(join(keyDir, STATE_A))).toEqual(stateBefore)
    expect((await prepare()).store.decryptString(sealed)).toBe('lin_api_secret')
  })

  it('refuses to seal or unseal when its record was bound to a different machine ID', async () => {
    const sealed = (await prepare()).store.encryptString('lin_api_secret')
    // A record copied in under this machine's name from another host.
    renameSync(join(keyDir, STATE_A), join(keyDir, orcadSecretStateFileName(MACHINE_B)))
    const moved = await prepare({ machine: MACHINE_B })
    expect(moved.ready).toBe(false)
    expect(() => moved.store.encryptString('new')).toThrow(/different machine ID/)
    expect(() => moved.store.decryptString(sealed)).toThrow(/different machine ID/)
    expect(moved.store.isEncryptionAvailable()).toBe(true)
  })

  it('never consults the OS keyring on a fresh host', async () => {
    const keyring = fakeLegacyKeyring({ key: 'unused' })
    const { store, ready } = await prepare({ legacyKeyring: keyring.read })
    expect(ready).toBe(true)
    expect(keyring.reads).toEqual([])
    expect(store.describeProtectionGap()).toContain('private credential directory')
    expect(JSON.parse(readFileSync(join(keyDir, STATE_A), 'utf8')).backend).toBe('host-file')
  })

  it('copies a key an older build kept in the OS keyring into the key file, once', async () => {
    const { encodedKey, sealed } = legacyKeyringHost()
    const keyring = fakeLegacyKeyring({ key: encodedKey })
    const log = vi.fn()
    const { store, ready } = await prepare({
      legacyKeyring: keyring.read,
      log
    })
    expect(ready).toBe(true)
    expect(store.decryptString(sealed)).toBe('lin_api_secret')
    expect(keyring.reads).toEqual(['home-0123456789abcdef'])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Copied the credential key'))
    const record = JSON.parse(readFileSync(join(keyDir, STATE_A), 'utf8'))
    expect(record).toMatchObject({
      backend: 'host-file',
      key: encodedKey,
      hostBound: false
    })
    if (process.platform !== 'win32') {
      expect(statSync(join(keyDir, STATE_A)).mode & 0o777).toBe(0o600)
    }

    const again = await prepare({ legacyKeyring: keyring.read })
    expect(again.store.decryptString(sealed)).toBe('lin_api_secret')
    expect(keyring.reads).toHaveLength(1)
  })

  it.each([
    ['locked', fakeLegacyKeyring({ failure: 'exited 36' }).read],
    ['timing out', fakeLegacyKeyring({ failure: 'timed out after 5s' }).read],
    [
      'holding a different key',
      fakeLegacyKeyring({ key: randomBytes(32).toString('base64') }).read
    ],
    ['unreachable from this session', null]
  ])(
    'starts a new key file rather than failing closed when the keyring is %s',
    async (_label, legacyKeyring) => {
      const { sealed } = legacyKeyringHost()
      const log = vi.fn()
      const { store, ready } = await prepare({ legacyKeyring, log })
      expect(ready).toBe(true)
      expect(log).toHaveBeenCalledTimes(1)
      expect(log.mock.calls[0][0]).toContain('Reconnect any integration')
      // Old credentials report the plain decrypt error, so the user reconnects.
      setSecretStore(store)
      expect(() => readStoredCredentialToken('Linear', sealed)).toThrow(
        credentialDecryptionMessage('Linear')
      )
      const saved = join(keyDir, 'saved.enc')
      writeEncryptedCredential('Linear', saved, 'lin_api_new')
      expect(readStoredCredentialToken('Linear', readFileSync(saved))).toBe('lin_api_new')
      // Later starts load the file and never ask the keyring again.
      const later = fakeLegacyKeyring({ failure: 'exited 36' })
      expect(
        (await prepare({ legacyKeyring: later.read })).store.decryptString(readFileSync(saved))
      ).toBe('lin_api_new')
      expect(later.reads).toEqual([])
    }
  )

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'treats a record it cannot read as unavailable, never as missing',
    async () => {
      const sealed = (await prepare()).store.encryptString('lin_api_secret')
      const statePath = join(keyDir, STATE_A)
      const before = readFileSync(statePath)
      chmodSync(statePath, 0o000)
      try {
        const { store, ready } = await prepare()
        expect(ready).toBe(false)
        expect(() => store.decryptString(sealed)).toThrow(/could not be read/)
      } finally {
        chmodSync(statePath, 0o600)
      }
      expect(readFileSync(statePath)).toEqual(before)
    }
  )

  it('agrees on one key when two servers start against the same home at once', async () => {
    const [first, second] = await Promise.all([prepare(), prepare()])
    expect(first.ready && second.ready).toBe(true)
    expect(second.store.decryptString(first.store.encryptString('a'))).toBe('a')

    rmSync(join(keyDir, STATE_A))
    const { encodedKey, sealed } = legacyKeyringHost()
    const keyring = fakeLegacyKeyring({ key: encodedKey })
    const migrated = await Promise.all([
      prepare({ legacyKeyring: keyring.read }),
      prepare({ legacyKeyring: keyring.read })
    ])
    expect(migrated.map(({ store }) => store.decryptString(sealed))).toEqual([
      'lin_api_secret',
      'lin_api_secret'
    ])
  })

  it('lets the first start migrate while a concurrent one with a locked keyring waits', async () => {
    const { encodedKey, sealed } = legacyKeyringHost()
    let enterMigration = (): void => {}
    const migrating = new Promise<void>((resolveEntered) => {
      enterMigration = resolveEntered
    })
    const slowSuccess: OrcadLegacyKeyringReader = async () => {
      enterMigration()
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
      return { key: encodedKey }
    }
    const fastFailure = fakeLegacyKeyring({ failure: 'exited 36' })
    const firstStart = prepare({ legacyKeyring: slowSuccess })
    // Why: start the second only once the first holds the lock; otherwise lock order is a race.
    await migrating
    const second = await prepare({ legacyKeyring: fastFailure.read })
    const first = await firstStart
    expect(first.store.decryptString(sealed)).toBe('lin_api_secret')
    expect(second.store.decryptString(sealed)).toBe('lin_api_secret')
    expect(fastFailure.reads).toEqual([])
    expect((await prepare()).store.decryptString(second.store.encryptString('n'))).toBe('n')
    expect(readdirSync(keyDir)).toEqual([STATE_A])
  })

  it('takes over a migration lock its crashed holder left behind', async () => {
    const { encodedKey, sealed } = legacyKeyringHost()
    // A lock a crashed start left behind, older than the lock's staleness window.
    const lock = join(keyDir, `${STATE_A}.lock`)
    mkdirSync(lock)
    utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    const { store, ready } = await prepare({
      legacyKeyring: fakeLegacyKeyring({ key: encodedKey }).read
    })
    expect(ready).toBe(true)
    expect(store.decryptString(sealed)).toBe('lin_api_secret')
    expect(readdirSync(keyDir)).toEqual([STATE_A])
  })

  it('never regenerates over an unreadable key record', async () => {
    const statePath = join(keyDir, STATE_A)
    writeFileSync(statePath, '{"version":1,"backend":"host-file"', 'utf8')
    const { store, ready } = await prepare()
    expect(ready).toBe(false)
    expect(() => store.encryptString('x')).toThrow(/not valid/)
    expect(readFileSync(statePath, 'utf8')).toBe('{"version":1,"backend":"host-file"')
  })

  it('records an unbound key when the host has no machine ID', async () => {
    const { store } = await prepare({ machine: null })
    expect(store.describeProtectionGap()).not.toContain('machine ID')
    const sealed = store.encryptString('t')
    expect((await prepare({ machine: null })).store.decryptString(sealed)).toBe('t')
  })

  it('leaves the persistent credential home alone for a temporary profile', async () => {
    const store = createOrcadSecretStore()
    const ready = await store.prepare({
      keyDir,
      userDataPath: '/tmp/orcad-smoke-profile',
      env: {},
      legacyKeyring: null,
      machineIdentity: () => MACHINE_A
    })
    expect(ready).toBe(false)
    expect(store.isEncryptionAvailable()).toBe(false)
    expect(store.describeProtectionGap()).toContain('temporary profile')
    expect(readdirSync(keyDir)).toEqual([])
  })

  it('keeps the explicit plaintext opt-out for shared homes', async () => {
    const { store, ready } = await prepare({
      env: { ORCA_HEADLESS_SECRET_STORE: 'plaintext' }
    })
    expect(ready).toBe(false)
    expect(store.isEncryptionAvailable()).toBe(false)
    expect(store.describeProtectionGap()).toContain('ORCA_HEADLESS_SECRET_STORE=plaintext')
  })

  it('makes integration credential saves seal, and still reads legacy plaintext', async () => {
    const { store } = await prepare()
    setSecretStore(store)
    const legacy = join(keyDir, 'legacy.enc')
    writeFileSync(legacy, 'lin_api_legacy', 'utf8')
    expect(readStoredCredentialToken('Linear', readFileSync(legacy))).toBe('lin_api_legacy')

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const saved = join(keyDir, 'saved.enc')
    writeEncryptedCredential('Linear', saved, 'lin_api_new')
    expect(warn).not.toHaveBeenCalled()
    expect(readFileSync(saved).includes(Buffer.from('lin_api_new'))).toBe(false)
    expect(readStoredCredentialToken('Linear', readFileSync(saved))).toBe('lin_api_new')
  })

  it('fails a save closed when the key cannot load, keeping the sealed file', async () => {
    const saved = join(keyDir, 'saved.enc')
    setSecretStore((await prepare()).store)
    writeEncryptedCredential('Linear', saved, 'lin_api_original')
    const before = readFileSync(saved)

    renameSync(join(keyDir, STATE_A), join(keyDir, orcadSecretStateFileName(MACHINE_B)))
    setSecretStore((await prepare({ machine: MACHINE_B })).store)
    expect(() => writeEncryptedCredential('Linear', saved, 'lin_api_replacement')).toThrow()
    expect(readFileSync(saved)).toEqual(before)
  })
})
