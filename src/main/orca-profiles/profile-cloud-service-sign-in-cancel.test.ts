import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OrcaCloudSignInEnd, OrcaProfileCloudSummary } from '../../shared/orca-profiles'

const { beginOrcaCloudPkceFlowMock, exchangeOrcaCloudAuthCodeMock, safeStorageMock } = vi.hoisted(
  () => ({
    beginOrcaCloudPkceFlowMock: vi.fn(),
    exchangeOrcaCloudAuthCodeMock: vi.fn(),
    safeStorageMock: {
      decryptString: vi.fn((value: Buffer) => value.toString('utf-8')),
      encryptString: vi.fn((value: string) => Buffer.from(value, 'utf-8')),
      isEncryptionAvailable: vi.fn(() => true)
    }
  })
)

let userDataPath = ''

vi.mock('electron', () => ({
  app: { getPath: () => userDataPath },
  safeStorage: safeStorageMock
}))

vi.mock('./profile-cloud-pkce', () => ({
  beginOrcaCloudPkceFlow: beginOrcaCloudPkceFlowMock
}))

vi.mock('./profile-cloud-client', () => ({
  createOrcaCloudProfile: vi.fn(),
  exchangeOrcaCloudAuthCode: exchangeOrcaCloudAuthCodeMock,
  revokeOrcaCloudSession: vi.fn(async () => undefined),
  selectOrcaCloudOrg: vi.fn()
}))

import { connectCurrentOrcaProfile, getCurrentOrcaProfileAuthStatus } from './profile-cloud-service'
import {
  cancelOrcaCloudSignIn,
  getOrcaCloudSignInProgress,
  onOrcaCloudSignInProgressChanged,
  resetOrcaCloudSignInProgressForTests
} from './profile-cloud-sign-in-progress'

const cloud: OrcaProfileCloudSummary = {
  cloudProfileId: 'cloud-profile-1',
  userId: 'user-1',
  email: 'nina@example.com',
  displayName: 'Nina',
  linkedAt: 10
}

// A fixed far-future expiry: no wall clock in tests.
const EXPIRES_AT = 4_102_444_800_000

const code = {
  code: 'the-code',
  codeVerifier: 'verifier',
  nonce: 'nonce',
  redirectUri: 'http://127.0.0.1:4100/auth/callback',
  state: 'state'
}

/** Waits for the browser like the real loopback: rejects when the attempt is aborted. */
function pendingBrowser(): {
  answer: (value: typeof code) => void
  fail: (error: Error) => void
} {
  const handle = {
    answer: (_value: typeof code): void => undefined,
    fail: (_error: Error): void => undefined
  }
  beginOrcaCloudPkceFlowMock.mockImplementationOnce(
    (_config: unknown, _profile: string, options: { signal?: AbortSignal }) =>
      new Promise((resolve, reject) => {
        handle.answer = resolve
        handle.fail = reject
        options.signal?.addEventListener('abort', () =>
          reject(new Error('orca_cloud_auth_cancelled'))
        )
      })
  )
  return handle
}

describe('Orca Cloud sign-in cancel, supersede and timeout', () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-cloud-sign-in-cancel-'))
    beginOrcaCloudPkceFlowMock.mockReset()
    exchangeOrcaCloudAuthCodeMock.mockReset()
    exchangeOrcaCloudAuthCodeMock.mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: EXPIRES_AT,
      cloud,
      organizations: [],
      capabilities: { flags: {}, refreshedAt: 1 }
    })
    vi.stubEnv('ORCA_CLOUD_API_URL', 'https://orca-cloud.example')
    vi.stubEnv('ORCA_CLOUD_CLIENT_ID', 'desktop-client')
  })

  afterEach(() => {
    resetOrcaCloudSignInProgressForTests()
    rmSync(userDataPath, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('Cancel while the browser is open ends the sign-in and clears progress', async () => {
    pendingBrowser()
    const connect = connectCurrentOrcaProfile(userDataPath)
    await vi.waitFor(() => expect(getOrcaCloudSignInProgress()).not.toBeNull())
    cancelOrcaCloudSignIn()
    expect(getOrcaCloudSignInProgress()).toBeNull()
    await expect(connect).resolves.toMatchObject({ status: 'cancelled' })
    expect(getCurrentOrcaProfileAuthStatus(userDataPath).state).not.toBe('connected')
  })

  it('Cancel after the browser answered still wins: the session is not saved', async () => {
    const browser = pendingBrowser()
    let finishExchange!: () => void
    exchangeOrcaCloudAuthCodeMock.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (finishExchange = resolve))
      return {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: EXPIRES_AT,
        cloud,
        organizations: [],
        capabilities: { flags: {}, refreshedAt: 1 }
      }
    })
    const connect = connectCurrentOrcaProfile(userDataPath)
    await vi.waitFor(() => expect(beginOrcaCloudPkceFlowMock).toHaveBeenCalled())
    browser.answer(code)
    await vi.waitFor(() => expect(exchangeOrcaCloudAuthCodeMock).toHaveBeenCalled())
    cancelOrcaCloudSignIn()
    finishExchange()
    await expect(connect).resolves.toMatchObject({ status: 'cancelled' })
    expect(getCurrentOrcaProfileAuthStatus(userDataPath).state).not.toBe('connected')
  })

  it('a second sign-in replaces the first: the first closes, the second signs in', async () => {
    pendingBrowser()
    const second = pendingBrowser()
    const first = connectCurrentOrcaProfile(userDataPath)
    const later = connectCurrentOrcaProfile(userDataPath)
    await expect(first).resolves.toMatchObject({ status: 'cancelled' })
    expect(getOrcaCloudSignInProgress()).not.toBeNull()
    second.answer(code)
    await expect(later).resolves.toMatchObject({ status: 'connected' })
    expect(getOrcaCloudSignInProgress()).toBeNull()
    expect(getCurrentOrcaProfileAuthStatus(userDataPath).cloud?.email).toBe('nina@example.com')
  })

  it('a timed-out sign-in clears progress and says it did not finish', async () => {
    const ends: (OrcaCloudSignInEnd | undefined)[] = []
    onOrcaCloudSignInProgressChanged((progress, end) => {
      if (!progress) {
        ends.push(end)
      }
    })
    const browser = pendingBrowser()
    const connect = connectCurrentOrcaProfile(userDataPath)
    await vi.waitFor(() => expect(beginOrcaCloudPkceFlowMock).toHaveBeenCalled())
    browser.fail(new Error('orca_cloud_auth_timeout'))
    await expect(connect).resolves.toMatchObject({ status: 'timed-out' })
    expect(getOrcaCloudSignInProgress()).toBeNull()
    expect(ends).toEqual(['timed-out'])
  })
})
