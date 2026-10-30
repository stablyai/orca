import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SecretStore } from '../../shared/secret-store'
import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secret-store'
import { readStoredCredentialToken } from '../integration-credential-file'
import { migratePlaintextCredentials } from './orcad-plaintext-credential-migration'
import { orcadSecretStateFileName } from './orcad-secret-key-record'
import { createOrcadSecretStore } from './orcad-secret-store'

describe('migratePlaintextCredentials', () => {
  let dir: string
  let store: SecretStore
  const logs: string[] = []
  const log = (message: string): void => {
    logs.push(message)
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'orcad-credential-migration-'))
    const orcadStore = createOrcadSecretStore()
    await orcadStore.prepare({
      keyDir: dir,
      platform: 'linux',
      env: {},
      legacyKeyring: null,
      machineIdentity: () => '0123456789abcdef0123456789abcdef'
    })
    store = orcadStore
    setSecretStore(store)
    logs.length = 0
  })

  afterEach(() => {
    _resetSecretStoreForTests()
    rmSync(dir, { recursive: true, force: true })
  })

  it('seals a legacy plaintext token in place without losing it, and tightens its mode', () => {
    const path = join(dir, 'linear-token.enc')
    writeFileSync(path, 'lin_api_plaintext', 'utf8')
    chmodSync(path, 0o644)

    expect(migratePlaintextCredentials(store, [{ path, raw: true }], log)).toEqual({
      sealed: 1,
      failed: 0
    })
    const raw = readFileSync(path)
    expect(raw.includes(Buffer.from('lin_api_plaintext'))).toBe(false)
    expect(readStoredCredentialToken('Linear', raw)).toBe('lin_api_plaintext')
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
    expect(logs.join('\n')).not.toContain('lin_api_plaintext')
  })

  it("stages in its own temp file, never a concurrent writer's shared one", () => {
    const path = join(dir, 'linear-token.enc')
    writeFileSync(path, 'lin_api_plaintext', 'utf8')
    writeFileSync(`${path}.tmp`, 'other-writer-in-progress', 'utf8')

    migratePlaintextCredentials(store, [{ path, raw: true }], log)
    expect(readFileSync(`${path}.tmp`, 'utf8')).toBe('other-writer-in-progress')
    expect(readStoredCredentialToken('Linear', readFileSync(path))).toBe('lin_api_plaintext')
  })

  it('rewrites a plaintext envelope as an encrypted one', () => {
    const path = join(dir, 'minimax-api-key.enc')
    const prefix = 'orca-minimax-api-key:v1:'
    writeFileSync(path, `${prefix}plaintext:${Buffer.from('mm-key').toString('base64')}`)

    migratePlaintextCredentials(store, [{ path, envelopePrefix: prefix }], log)
    const text = readFileSync(path, 'utf8')
    expect(text.startsWith(`${prefix}encrypted:`)).toBe(true)
    expect(
      store.decryptString(Buffer.from(text.slice(`${prefix}encrypted:`.length), 'base64'))
    ).toBe('mm-key')
  })

  it('leaves sealed files, foreign ciphertext, and the speech JSON format alone', () => {
    const sealedPath = join(dir, 'sealed.enc')
    const sealed = store.encryptString('already')
    writeFileSync(sealedPath, sealed)
    const foreignPath = join(dir, 'foreign.enc')
    const foreign = Buffer.from([0x76, 0x31, 0x30, 0x00, 0xff, 0x10])
    writeFileSync(foreignPath, foreign)

    expect(
      migratePlaintextCredentials(
        store,
        [
          { path: sealedPath, raw: true },
          { path: foreignPath, raw: true },
          { path: join(dir, 'absent.enc'), raw: true }
        ],
        log
      )
    ).toEqual({ sealed: 0, failed: 0 })
    expect(readFileSync(sealedPath)).toEqual(sealed)
    expect(readFileSync(foreignPath)).toEqual(foreign)
  })

  it('leaves the plaintext file intact when sealing fails', async () => {
    const path = join(dir, 'jira.enc')
    writeFileSync(path, 'jira-plaintext', 'utf8')
    const otherMachine = 'fedcba9876543210fedcba9876543210'
    writeFileSync(join(dir, orcadSecretStateFileName(otherMachine)), '{', 'utf8')
    const locked = createOrcadSecretStore()
    await locked.prepare({
      keyDir: dir,
      platform: 'linux',
      env: {},
      legacyKeyring: null,
      machineIdentity: () => otherMachine
    })

    expect(migratePlaintextCredentials(locked, [{ path, raw: true }], log)).toEqual({
      sealed: 0,
      failed: 1
    })
    expect(readFileSync(path, 'utf8')).toBe('jira-plaintext')
    expect(logs.join('\n')).not.toContain('jira-plaintext')
  })
})
