import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  app: {
    getPath: () => userDataPath
  },
  safeStorage: safeStorageMock
}))

vi.mock('./profile-cloud-pkce', () => ({
  beginOrcaCloudPkceFlow: beginOrcaCloudPkceFlowMock
}))

vi.mock('./profile-cloud-client', () => ({
  createOrcaCloudProfile: vi.fn(),
  exchangeOrcaCloudAuthCode: exchangeOrcaCloudAuthCodeMock,
  revokeOrcaCloudSession: vi.fn().mockResolvedValue(undefined),
  selectOrcaCloudOrg: vi.fn()
}))

import { connectCurrentOrcaProfile, signOutCurrentOrcaProfile } from './profile-cloud-service'
import {
  cancelOrcaCloudSignIn,
  getOrcaCloudSignInProgress,
  onOrcaCloudSignInProgressChanged
} from './profile-cloud-sign-in-progress'

type BrowserWait = {
  link: string
  publish: () => void
  answer: (code: string) => void
  fail: (error: Error) => void
}

function queueBrowserWaits(): BrowserWait[] {
  const waits: BrowserWait[] = []
  beginOrcaCloudPkceFlowMock.mockImplementation(
    (
      _config,
      _profileId,
      options: { onAuthorizeUrl: (link: string) => void; signal: AbortSignal }
    ) =>
      new Promise((resolve, reject) => {
        const link = `https://orca-cloud.example/authorize?attempt=${waits.length + 1}`
        options.signal.addEventListener('abort', () =>
          reject(new Error('orca_cloud_auth_cancelled'))
        )
        waits.push({
          link,
          publish: () => options.onAuthorizeUrl(link),
          answer: (code) =>
            resolve({
              code,
              codeVerifier: 'verifier',
              nonce: 'nonce',
              redirectUri: 'http://127.0.0.1:4100/auth/callback',
              state: 'state'
            }),
          fail: reject
        })
      })
  )
  return waits
}

describe('Orca cloud sign-in progress', () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-cloud-sign-in-progress-'))
    beginOrcaCloudPkceFlowMock.mockReset()
    exchangeOrcaCloudAuthCodeMock.mockReset()
    vi.stubEnv('ORCA_CLOUD_API_URL', 'https://orca-cloud.example')
    vi.stubEnv('ORCA_CLOUD_CLIENT_ID', 'desktop-client')
  })

  afterEach(async () => {
    await signOutCurrentOrcaProfile(userDataPath)
    rmSync(userDataPath, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('announces the newest wait and ends it when the wait times out', async () => {
    const changes: unknown[] = []
    const unsubscribe = onOrcaCloudSignInProgressChanged((progress) => changes.push(progress))
    const waits = queueBrowserWaits()
    const first = connectCurrentOrcaProfile(userDataPath)
    const second = connectCurrentOrcaProfile(userDataPath)
    await vi.waitFor(() => expect(waits).toHaveLength(2))
    waits[1].publish()

    waits[0].fail(new Error('orca_cloud_auth_timeout'))
    await expect(first).resolves.toMatchObject({ status: 'cancelled' })
    expect(getOrcaCloudSignInProgress()).toEqual({ link: waits[1].link })

    waits[1].fail(new Error('orca_cloud_auth_timeout'))
    await expect(second).resolves.toMatchObject({ status: 'timed-out' })
    expect(changes).toEqual([{ link: null }, { link: null }, { link: waits[1].link }, null])
    unsubscribe()
  })

  it('keeps the newest link when an older attempt reports its link late and then ends', async () => {
    const waits = queueBrowserWaits()
    const older = connectCurrentOrcaProfile(userDataPath)
    void connectCurrentOrcaProfile(userDataPath)
    await vi.waitFor(() => expect(waits).toHaveLength(2))

    waits[1].publish()
    waits[0].publish()
    expect(getOrcaCloudSignInProgress()).toEqual({ link: waits[1].link })

    waits[0].fail(new Error('orca_cloud_auth_denied'))
    await expect(older).resolves.toMatchObject({ status: 'cancelled' })
    expect(getOrcaCloudSignInProgress()).toEqual({ link: waits[1].link })
  })

  it('drops the link once the browser answers but stays in progress until sign-in ends', async () => {
    const waits = queueBrowserWaits()
    let failExchange!: (error: Error) => void
    exchangeOrcaCloudAuthCodeMock.mockReturnValue(
      new Promise((_resolve, reject) => {
        failExchange = reject
      })
    )
    const attempt = connectCurrentOrcaProfile(userDataPath)
    await vi.waitFor(() => expect(waits).toHaveLength(1))
    waits[0].publish()

    waits[0].answer('code')
    await vi.waitFor(() => expect(exchangeOrcaCloudAuthCodeMock).toHaveBeenCalledOnce())
    expect(getOrcaCloudSignInProgress()).toEqual({ link: null })

    failExchange(new Error('exchange_failed'))
    await expect(attempt).resolves.toMatchObject({ status: 'failed' })
    expect(getOrcaCloudSignInProgress()).toBeNull()
  })

  it('cancels the browser wait silently', async () => {
    const waits = queueBrowserWaits()
    const attempt = connectCurrentOrcaProfile(userDataPath)
    await vi.waitFor(() => expect(waits).toHaveLength(1))
    waits[0].publish()

    cancelOrcaCloudSignIn()

    await expect(attempt).resolves.toMatchObject({ status: 'cancelled' })
    expect(getOrcaCloudSignInProgress()).toBeNull()
  })

  it('ends the progress on sign-out', async () => {
    const waits = queueBrowserWaits()
    const attempt = connectCurrentOrcaProfile(userDataPath)
    await vi.waitFor(() => expect(waits).toHaveLength(1))
    waits[0].publish()

    await signOutCurrentOrcaProfile(userDataPath)
    expect(getOrcaCloudSignInProgress()).toBeNull()
    waits[0].fail(new Error('orca_cloud_auth_timeout'))
    await expect(attempt).resolves.toMatchObject({ status: 'cancelled' })
  })
})
