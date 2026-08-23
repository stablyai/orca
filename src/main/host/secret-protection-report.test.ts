import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secret-store'
import { reportSecretProtectionGap } from './secret-protection-report'

const WEAK = 'Secrets are obfuscated with a built-in key.'

describe('reportSecretProtectionGap', () => {
  let dir: string
  let dataFile: string
  let logged: string[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-secret-report-'))
    dataFile = join(dir, 'orca-data.json')
    logged = []
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function installStore(gap: string | null): void {
    setSecretStore({
      isEncryptionAvailable: () => true,
      encryptString: (plainText) => Buffer.from(plainText),
      decryptString: (cipher) => cipher.toString(),
      describeProtectionGap: () => gap
    })
  }

  const report = (force = false): string | null =>
    reportSecretProtectionGap({ dataFile, log: (m) => void logged.push(m), force })

  it('reports a new gap once, then stays quiet on every later launch', () => {
    // Why this is the point: the gap usually needs a keyring install to fix, so
    // repeating it every start is nagging the user cannot act on.
    installStore(WEAK)
    expect(report()).toBe(WEAK)
    expect(logged).toHaveLength(1)

    report()
    report()
    expect(logged).toHaveLength(1)
  })

  it('reports again when the gap changes to a different reason', () => {
    installStore(WEAK)
    report()
    installStore('The OS keyring is unavailable.')
    report()
    expect(logged).toHaveLength(2)
    expect(logged[1]).toContain('keyring is unavailable')
  })

  it('announces recovery, so an earlier warning is not left standing', () => {
    installStore(WEAK)
    report()
    installStore(null)
    report()
    expect(logged).toHaveLength(2)
    expect(logged[1]).toMatch(/now provided by the OS keyring/)

    report()
    expect(logged).toHaveLength(2)
  })

  it('stays silent from a clean start when secrets are properly sealed', () => {
    installStore(null)
    expect(report()).toBeNull()
    expect(logged).toEqual([])
  })

  it('re-reports on demand for support, without disturbing stored state', () => {
    installStore(WEAK)
    report()
    expect(report(true)).toBe(WEAK)
    expect(logged).toHaveLength(2)
    report()
    expect(logged).toHaveLength(2)
  })

  it('re-reports when the stored state is corrupt rather than trusting it', () => {
    installStore(WEAK)
    writeFileSync(join(dir, 'orca-secret-protection.json'), '{ not json', 'utf-8')
    expect(report()).toBe(WEAK)
    expect(logged).toHaveLength(1)
  })

  it('does not throw startup when no store is installed', () => {
    _resetSecretStoreForTests()
    expect(() => report()).not.toThrow()
    expect(logged[0]).toContain('could not determine at-rest protection')
  })
})
