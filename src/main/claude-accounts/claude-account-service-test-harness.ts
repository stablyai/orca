import { vi } from 'vitest'
import {
  deleteActiveClaudeKeychainCredentialsStrict,
  readActiveClaudeKeychainCredentials,
  readActiveClaudeKeychainCredentialsStrict,
  readManagedClaudeKeychainCredentials,
  writeActiveClaudeKeychainCredentials,
  writeManagedClaudeKeychainCredentials
} from './keychain'

// Each suite declares its own `vi.mock('./keychain', ...)` (factories are hoisted and
// cannot close over this module); this only re-arms the doubles between tests.
export function resetClaudeKeychainMocks(): void {
  vi.mocked(readActiveClaudeKeychainCredentials).mockReset()
  vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockReset()
  vi.mocked(readManagedClaudeKeychainCredentials).mockReset()
  vi.mocked(deleteActiveClaudeKeychainCredentialsStrict).mockClear()
  vi.mocked(writeActiveClaudeKeychainCredentials).mockReset()
  vi.mocked(writeActiveClaudeKeychainCredentials).mockResolvedValue()
  vi.mocked(writeManagedClaudeKeychainCredentials).mockReset()
  vi.mocked(writeManagedClaudeKeychainCredentials).mockResolvedValue()
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

export function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })
}

export function restorePlatform(): void {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
}

export function createService(): unknown {
  return {}
}
