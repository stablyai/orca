import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setSecretStore } from '../../shared/secret-store'
import { DeepSeekCredentials } from './deepseek-credentials'
import type { DeepSeekBalance } from '../../shared/deepseek-balance'

export const SYNTHETIC_DEEPSEEK_KEY = 'sk-orca-deepseek-loopback-only'
export const DEEPSEEK_FIXTURE_BALANCE: DeepSeekBalance = {
  is_available: true,
  balance_infos: [
    {
      currency: 'CNY',
      total_balance: '9007199254740993.00100',
      granted_balance: '0.00100',
      topped_up_balance: '9007199254740993.00000'
    },
    {
      currency: 'USD',
      total_balance: '12.3400',
      granted_balance: '2.3400',
      topped_up_balance: '10.0000'
    }
  ]
}

// Test-only AES adapter: proves sealed file behavior without touching a user's keyring.
export function installDeepSeekTestSecretStore(): void {
  const key = randomBytes(32)
  setSecretStore({
    isEncryptionAvailable: () => true,
    describeProtectionGap: () => null,
    encryptString: (value) => {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
    },
    decryptString: (bytes) => {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      decipher.setAuthTag(bytes.subarray(12, 28))
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
    }
  })
}

export function deepSeekCredentialFixture(ownerId = 'fixture-host') {
  const directory = mkdtempSync(join(tmpdir(), 'orca-deepseek-credential-'))
  const path = join(directory, 'deepseek-api-key.enc')
  return { directory, path, credentials: new DeepSeekCredentials(ownerId, path) }
}
