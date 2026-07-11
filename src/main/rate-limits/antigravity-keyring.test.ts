import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileSyncMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock
}))

import {
  readAntigravityKeyringCredentials,
  writeAntigravityKeyringCredentials
} from './antigravity-keyring'

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

// The real agy blob shape from Windows Credential Manager `gemini:antigravity`.
const AGY_BLOB = JSON.stringify({
  token: {
    access_token: 'ya29.test-access',
    token_type: 'Bearer',
    refresh_token: '1//test-refresh',
    expiry: '2026-07-09T16:35:43.000Z'
  },
  auth_method: 'consumer'
})

describe('readAntigravityKeyringCredentials', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset()
  })

  afterEach(() => {
    setPlatform(originalPlatform)
    vi.clearAllMocks()
  })

  it('reads and normalizes the Windows Credential Manager blob', () => {
    setPlatform('win32')
    execFileSyncMock.mockReturnValue(AGY_BLOB)
    const creds = readAntigravityKeyringCredentials()
    expect(creds).not.toBeNull()
    expect(creds?.access_token).toBe('ya29.test-access')
    expect(creds?.refresh_token).toBe('1//test-refresh')
    expect(creds?.expiry_date).toBe(new Date('2026-07-09T16:35:43.000Z').getTime())
    // Passed the CredRead script via -EncodedCommand.
    const [cmd, args] = execFileSyncMock.mock.calls[0] as [string, string[]]
    expect(cmd).toBe('powershell')
    expect(args).toContain('-EncodedCommand')
  })

  it('tolerates a flat token shape without the token wrapper', () => {
    setPlatform('win32')
    execFileSyncMock.mockReturnValue(
      JSON.stringify({
        access_token: 'flat-access',
        refresh_token: 'flat-refresh',
        expiry_date: 1_783_614_943_568
      })
    )
    const creds = readAntigravityKeyringCredentials()
    expect(creds?.access_token).toBe('flat-access')
    expect(creds?.expiry_date).toBe(1_783_614_943_568)
  })

  it('returns null when the credential is absent (CredRead miss throws)', () => {
    setPlatform('win32')
    execFileSyncMock.mockImplementation(() => {
      throw new Error('Command failed: exit 1')
    })
    expect(readAntigravityKeyringCredentials()).toBeNull()
  })

  it('returns null on malformed JSON', () => {
    setPlatform('win32')
    execFileSyncMock.mockReturnValue('not json')
    expect(readAntigravityKeyringCredentials()).toBeNull()
  })

  it('uses the macOS security tool on darwin', () => {
    setPlatform('darwin')
    execFileSyncMock.mockReturnValue(AGY_BLOB)
    const creds = readAntigravityKeyringCredentials()
    expect(creds?.access_token).toBe('ya29.test-access')
    const [cmd] = execFileSyncMock.mock.calls[0] as [string, string[]]
    expect(cmd).toBe('security')
  })

  it('returns null on unsupported platforms without invoking a shell', () => {
    setPlatform('freebsd' as NodeJS.Platform)
    expect(readAntigravityKeyringCredentials()).toBeNull()
    expect(execFileSyncMock).not.toHaveBeenCalled()
  })

  it('write returns false (never throws) on a bad expiry_date', () => {
    setPlatform('win32')
    const creds = { access_token: 'a', refresh_token: 'r', expiry_date: Number.NaN }
    // A NaN expiry makes toISOString() throw; it must resolve to false, and the
    // failure must be caught before any shell-out.
    expect(writeAntigravityKeyringCredentials(creds)).toBe(false)
    expect(execFileSyncMock).not.toHaveBeenCalled()
  })

  it('write returns false on non-Windows platforms without a shell-out', () => {
    setPlatform('darwin')
    const creds = { access_token: 'a', refresh_token: 'r', expiry_date: Date.now() }
    expect(writeAntigravityKeyringCredentials(creds)).toBe(false)
    expect(execFileSyncMock).not.toHaveBeenCalled()
  })
})
