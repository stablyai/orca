import { describe, expect, it } from 'vitest'
import { setSecretStore, _resetSecretStoreForTests } from '../../shared/secret-store'
import { reportSecretProtectionGap } from './secret-protection-report'

function installStore(gap: string | null): void {
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (plainText) => Buffer.from(plainText),
    decryptString: (cipher) => cipher.toString(),
    describeProtectionGap: () => gap
  })
}

describe('reportSecretProtectionGap', () => {
  it('logs and returns the gap when protection is weaker than a user would assume', () => {
    installStore('Secrets are obfuscated with a built-in key.')
    const logged: string[] = []
    expect(reportSecretProtectionGap((m) => logged.push(m))).toMatch(/built-in key/)
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain('[secrets]')
  })

  it('stays silent when secrets are properly sealed', () => {
    installStore(null)
    const logged: string[] = []
    expect(reportSecretProtectionGap((m) => logged.push(m))).toBeNull()
    expect(logged).toEqual([])
  })

  it('does not throw startup when no store is installed', () => {
    // Why: this is diagnostics running early in bootstrap. The useful error is the one
    // raised by the first real read, not a crash from the thing reporting on it.
    _resetSecretStoreForTests()
    const logged: string[] = []
    expect(() => reportSecretProtectionGap((m) => logged.push(m))).not.toThrow()
    expect(logged[0]).toContain('could not determine at-rest protection')
  })
})
