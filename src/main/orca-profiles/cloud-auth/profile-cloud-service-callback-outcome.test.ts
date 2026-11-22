import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { get } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { openExternalMock, safeStorageMock } = vi.hoisted(() => ({
  openExternalMock: vi.fn(),
  safeStorageMock: {
    decryptString: vi.fn((value: Buffer) => value.toString('utf-8')),
    encryptString: vi.fn((value: string) => Buffer.from(value, 'utf-8')),
    isEncryptionAvailable: vi.fn(() => true)
  }
}))

let userDataPath = ''

vi.mock('electron', () => ({
  app: { getPath: () => userDataPath },
  safeStorage: safeStorageMock,
  shell: { openExternal: openExternalMock }
}))

import { connectCurrentOrcaProfile, signOutCurrentOrcaProfile } from './profile-cloud-service'

function readBrowserPage(url: string): Promise<{ statusCode?: number; body: string }> {
  return new Promise((resolve, reject) => {
    get(url, (response) => {
      response.setEncoding('utf-8')
      let body = ''
      response.on('data', (chunk: string) => {
        body += chunk
      })
      response.on('end', () => resolve({ statusCode: response.statusCode, body }))
    }).on('error', reject)
  })
}

// Plays the browser: the provider redirects to the loopback with a code.
function browserReturnsCode(): Promise<{ statusCode?: number; body: string }> {
  return new Promise((resolve, reject) => {
    openExternalMock.mockImplementationOnce(async (authorizeUrl: string) => {
      const authorize = new URL(authorizeUrl)
      const callback = new URL(authorize.searchParams.get('redirect_uri') ?? '')
      callback.searchParams.set('code', 'auth-code')
      callback.searchParams.set('state', authorize.searchParams.get('state') ?? '')
      readBrowserPage(callback.toString()).then(resolve, reject)
    })
  })
}

function sessionResponse(): Response {
  return new Response(
    JSON.stringify({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      // Far-future expiry keeps the session valid without reading the wall clock.
      expiresAt: Date.UTC(2100, 0, 1),
      cloud: { cloudProfileId: 'cloud-1', userId: 'user-1', email: 'nina@example.com' }
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )
}

describe('Orca sign-in browser page', () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-cloud-callback-outcome-'))
    vi.stubEnv('ORCA_CLOUD_API_URL', 'https://orca-cloud.example')
    vi.stubEnv('ORCA_CLOUD_CLIENT_ID', 'desktop-client')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    openExternalMock.mockReset()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('does not tell the browser sign-in succeeded when the code exchange fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"unavailable"}', { status: 503 }))
    )
    const browser = browserReturnsCode()

    const result = await connectCurrentOrcaProfile(userDataPath, openExternalMock)
    const page = await browser

    expect(result.status).toBe('failed')
    expect(result.auth.state).toBe('local')
    // The tab got its first part before the exchange, so a failure is in the page, not the status.
    expect(page.statusCode).toBe(200)
    expect(page.body).not.toContain('Signed in to Orca')
    expect(page.body).toContain('orca_cloud_request_failed_503')
  })

  it('tells the browser sign-in succeeded once the profile is connected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sessionResponse())
    )
    const browser = browserReturnsCode()

    const result = await connectCurrentOrcaProfile(userDataPath, openExternalMock)
    const page = await browser

    expect(result.status).toBe('connected')
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('Signed in to Orca')
  })

  it('shows a neutral cancelled page when sign-out lands during the code exchange', async () => {
    let signOut: Promise<unknown> = Promise.resolve()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        signOut = signOutCurrentOrcaProfile(userDataPath)
        return sessionResponse()
      })
    )
    const browser = browserReturnsCode()

    const result = await connectCurrentOrcaProfile(userDataPath, openExternalMock)
    const page = await browser
    await signOut

    expect(result.status).toBe('cancelled')
    expect(result.auth.state).toBe('local')
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('<h1>Orca sign-in was cancelled</h1>')
    expect(page.body).toContain('class="mark neutral"')
  })

  it('shows the signed-in page on an older tab once a newer tab connected the profile', async () => {
    let releaseFirstExchange = (): void => {}
    const firstExchangeHeld = new Promise<void>((resolve) => {
      releaseFirstExchange = resolve
    })
    let exchangeCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        exchangeCount += 1
        if (exchangeCount === 1) {
          await firstExchangeHeld
        }
        return sessionResponse()
      })
    )
    const firstTab = browserReturnsCode()
    const firstConnect = connectCurrentOrcaProfile(userDataPath, openExternalMock)
    await vi.waitFor(() => expect(exchangeCount).toBe(1))

    const secondTab = browserReturnsCode()
    const secondResult = await connectCurrentOrcaProfile(userDataPath, openExternalMock)
    const secondPage = await secondTab
    releaseFirstExchange()
    const firstResult = await firstConnect
    const firstPage = await firstTab

    expect(secondResult.status).toBe('connected')
    expect(secondPage.body).toContain('Signed in to Orca')
    expect(firstResult.status).toBe('cancelled')
    expect(firstResult.auth.state).toBe('connected')
    expect(firstPage.statusCode).toBe(200)
    expect(firstPage.body).toContain('Signed in to Orca')
  })
})
