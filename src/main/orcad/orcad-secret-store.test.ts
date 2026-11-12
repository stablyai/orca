import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetSecretStoreForTests } from '../../shared/secret-store'
import type { OrcadLegacyKeyringReader } from './orcad-legacy-keyring-key'
import { orcadSecretStateFileName } from './orcad-secret-key-record'
import { createOrcadSecretStore } from './orcad-secret-store'

const MACHINE_A = '0123456789abcdef0123456789abcdef'
const MACHINE_B = 'fedcba9876543210fedcba9876543210'
const STATE_A = orcadSecretStateFileName(MACHINE_A)

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
    renameSync(join(keyDir, STATE_A), join(keyDir, orcadSecretStateFileName(MACHINE_B)))
    const moved = await prepare({ machine: MACHINE_B })
    expect(moved.ready).toBe(false)
    expect(() => moved.store.encryptString('new')).toThrow(/different machine ID/)
    expect(() => moved.store.decryptString(sealed)).toThrow(/different machine ID/)
    expect(moved.store.isEncryptionAvailable()).toBe(true)
  })

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

  it('never regenerates over an unreadable key record', async () => {
    const statePath = join(keyDir, STATE_A)
    writeFileSync(statePath, '{"version":1,"backend":"host-file"', 'utf8')
    const { store, ready } = await prepare()
    expect(ready).toBe(false)
    expect(() => store.encryptString('x')).toThrow(/not valid/)
    expect(readFileSync(statePath, 'utf8')).toBe('{"version":1,"backend":"host-file"')
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
})
