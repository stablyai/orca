import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setSecretStore } from '../../shared/secret-store'

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
    // Repeat only on change: keyring remediation may not be immediately possible.
    installStore(WEAK)
    expect(report()).toBe(WEAK)
    expect(logged).toHaveLength(1)

    report()
    report()
    expect(logged).toHaveLength(1)
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
})
