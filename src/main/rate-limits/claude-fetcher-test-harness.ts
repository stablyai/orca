import { vi } from 'vitest'
import type { Mock } from 'vitest'
import { fetchViaPty } from './claude-pty'
import {
  deleteActiveClaudeKeychainCredentialsStrict,
  readActiveClaudeKeychainCredentials,
  readActiveClaudeKeychainCredentialsStrict,
  readManagedClaudeKeychainCredentials,
  writeActiveClaudeKeychainCredentials,
  writeManagedClaudeKeychainCredentials
} from '../claude-accounts/keychain'

/** Electron/fs mocks each claude-fetcher test file declares via its own `vi.mock` factories. */
export type ClaudeFetcherHoistedMocks = {
  netFetchMock: Mock
  readFileMock: Mock
  resolveProxyMock: Mock
  setProxyMock: Mock
  appGetPathMock: Mock
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

/** Default happy-path state: darwin, no keychain credentials, OAuth usage 12/34, PTY session 56. */
export function primeClaudeFetcherMocks(mocks: ClaudeFetcherHoistedMocks): void {
  setPlatform('darwin')
  vi.clearAllMocks()
  mocks.readFileMock.mockRejectedValue(new Error('missing file'))
  vi.mocked(readActiveClaudeKeychainCredentials).mockResolvedValue(null)
  vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValue(null)
  vi.mocked(readManagedClaudeKeychainCredentials).mockResolvedValue(null)
  vi.mocked(writeActiveClaudeKeychainCredentials).mockResolvedValue()
  vi.mocked(deleteActiveClaudeKeychainCredentialsStrict).mockResolvedValue()
  vi.mocked(writeManagedClaudeKeychainCredentials).mockResolvedValue()
  mocks.appGetPathMock.mockReturnValue('/tmp/orca-claude-fetcher-test')
  mocks.resolveProxyMock.mockResolvedValue('DIRECT')
  mocks.netFetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        five_hour: { utilization: 12 },
        seven_day: { utilization: 34 }
      }),
      { status: 200 }
    )
  )
  vi.mocked(fetchViaPty).mockResolvedValue({
    provider: 'claude',
    session: { usedPercent: 56, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt: 1,
    error: null,
    status: 'ok'
  })
}
