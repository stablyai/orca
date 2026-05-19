import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { getEncryptedSecretsFilePath } from './runtime-paths'

describe('getEncryptedSecretsFilePath', () => {
  it('joins userDataDir with claude-accounts/secrets.enc', () => {
    const userDataDir = '/some/user/data'
    expect(getEncryptedSecretsFilePath(userDataDir)).toBe(
      join(userDataDir, 'claude-accounts', 'secrets.enc')
    )
  })

  it('preserves the provided userDataDir prefix', () => {
    const result = getEncryptedSecretsFilePath('/tmp/orca-test')
    expect(result.startsWith('/tmp/orca-test')).toBe(true)
    expect(result.endsWith('secrets.enc')).toBe(true)
  })
})
