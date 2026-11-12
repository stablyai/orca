import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false }, shell: { openExternal: vi.fn() } }))

import type { OrcaCloudAuthConfig } from './cloud-auth/profile-cloud-auth-config'
import {
  beginOrcaCloudPkceFlow,
  ORCA_CLOUD_SIGN_IN_TIMEOUT_MS,
  orcaCloudSignInTimeoutMs
} from './cloud-auth/profile-cloud-pkce'

const base = 'https://auth.test'
const config: OrcaCloudAuthConfig = {
  apiBaseUrl: base,
  authorizeEndpoint: `${base}/v1/desktop/auth/authorize`,
  sessionEndpoint: `${base}/s`,
  refreshEndpoint: `${base}/r`,
  capabilitiesEndpoint: `${base}/c`,
  profileEndpoint: `${base}/p`,
  orgEndpoint: `${base}/o`,
  logoutEndpoint: `${base}/l`,
  relayTokenEndpoint: `${base}/rt`,
  connectorTokenEndpoint: `${base}/ct`,
  relayDirectorUrl: base,
  clientId: 'orca-desktop',
  scope: 'openid'
}

afterEach(() => {
  delete process.env.ORCA_CLOUD_DEV_OPEN_URL_FILE
  delete process.env.ORCA_CLOUD_SIGN_IN_TIMEOUT_MS
})

describe('PKCE loopback for cloud setup', () => {
  it('adds the setup parameters and holds the tab until setup says where it goes next', async () => {
    process.env.ORCA_CLOUD_DEV_OPEN_URL_FILE = join(mkdtempSync(join(tmpdir(), 'pkce-')), 'urls')
    let authorize = ''
    const flow = beginOrcaCloudPkceFlow(config, 'profile-1', {
      onAuthorizeUrl: (url) => (authorize = url),
      authorizeParams: { setup: '1', device: 'MacBook Pro', setup_steps: 'github' },
      holdBrowser: true
    })
    await vi.waitFor(() => expect(authorize).not.toBe(''))
    const url = new URL(authorize)
    expect(url.searchParams.get('setup')).toBe('1')
    expect(url.searchParams.get('device')).toBe('MacBook Pro')
    expect(url.searchParams.get('setup_steps')).toBe('github')
    expect(url.searchParams.get('signin_page')).toBeNull()

    const callback = new URL(url.searchParams.get('redirect_uri')!)
    callback.searchParams.set('code', 'the-code')
    callback.searchParams.set('state', url.searchParams.get('state')!)
    const browser = fetch(callback, { redirect: 'manual' })
    const code = await flow
    expect(code.code).toBe('the-code')
    expect(code.finishBrowser).toBeTypeOf('function')
    code.finishBrowser!('https://auth.test/cloud/setup/start?session=cs_x&ticket=t')
    const response = await browser
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(
      'https://auth.test/cloud/setup/start?session=cs_x&ticket=t'
    )
  })

  it('shows the signed-in page when setup has nowhere to go (or an unsafe URL)', async () => {
    process.env.ORCA_CLOUD_DEV_OPEN_URL_FILE = join(mkdtempSync(join(tmpdir(), 'pkce-')), 'urls')
    let authorize = ''
    const flow = beginOrcaCloudPkceFlow(config, 'profile-1', {
      onAuthorizeUrl: (url) => (authorize = url),
      holdBrowser: true
    })
    await vi.waitFor(() => expect(authorize).not.toBe(''))
    const url = new URL(authorize)
    const callback = new URL(url.searchParams.get('redirect_uri')!)
    callback.searchParams.set('code', 'c')
    callback.searchParams.set('state', url.searchParams.get('state')!)
    const browser = fetch(callback, { redirect: 'manual' })
    ;(await flow).finishBrowser!('javascript:alert(1)')
    expect((await browser).status).toBe(200)
  })
})

describe('PKCE loopback cancel and timeout', () => {
  let lastAuthorize: URL
  async function start(signal?: AbortSignal): Promise<{
    flow: Promise<unknown>
    redirect: URL
  }> {
    process.env.ORCA_CLOUD_DEV_OPEN_URL_FILE = join(mkdtempSync(join(tmpdir(), 'pkce-')), 'urls')
    let authorize = ''
    const flow = beginOrcaCloudPkceFlow(config, 'profile-1', {
      onAuthorizeUrl: (url) => (authorize = url),
      ...(signal ? { signal } : {})
    })
    flow.catch(() => undefined)
    await vi.waitFor(() => expect(authorize).not.toBe(''))
    lastAuthorize = new URL(authorize)
    return { flow, redirect: new URL(new URL(authorize).searchParams.get('redirect_uri')!) }
  }

  it('asks auth for the branded sign-in page on a plain sign-in, not on setup (V3-04)', async () => {
    const abort = new AbortController()
    const { flow } = await start(abort.signal)
    expect(lastAuthorize.searchParams.get('signin_page')).toBe('1')
    abort.abort()
    await expect(flow).rejects.toBeDefined()
  })

  it('Cancel rejects the wait and closes the loopback listener', async () => {
    const abort = new AbortController()
    const { flow, redirect } = await start(abort.signal)
    abort.abort()
    await expect(flow).rejects.toThrow('orca_cloud_auth_cancelled')
    // A late browser callback finds nothing listening.
    await expect(fetch(redirect)).rejects.toThrow()
  })

  it('an already-cancelled attempt never opens a listener', async () => {
    const abort = new AbortController()
    abort.abort()
    const onAuthorizeUrl = vi.fn()
    await expect(
      beginOrcaCloudPkceFlow(config, 'profile-1', { signal: abort.signal, onAuthorizeUrl })
    ).rejects.toThrow('orca_cloud_auth_cancelled')
    expect(onAuthorizeUrl).not.toHaveBeenCalled()
  })

  it('times out a sign-in the browser never finishes', async () => {
    process.env.ORCA_CLOUD_SIGN_IN_TIMEOUT_MS = '1000'
    const { flow, redirect } = await start()
    await expect(flow).rejects.toThrow('orca_cloud_auth_timeout')
    await expect(fetch(redirect)).rejects.toThrow()
  })

  it('waits five minutes by default; only unpackaged dev runs may shorten it', () => {
    expect(ORCA_CLOUD_SIGN_IN_TIMEOUT_MS).toBe(300_000)
    expect(orcaCloudSignInTimeoutMs({}, false)).toBe(300_000)
    expect(orcaCloudSignInTimeoutMs({ ORCA_CLOUD_SIGN_IN_TIMEOUT_MS: '60000' }, false)).toBe(60_000)
    expect(orcaCloudSignInTimeoutMs({ ORCA_CLOUD_SIGN_IN_TIMEOUT_MS: '60000' }, true)).toBe(300_000)
    expect(orcaCloudSignInTimeoutMs({ ORCA_CLOUD_SIGN_IN_TIMEOUT_MS: '10' }, false)).toBe(300_000)
    expect(orcaCloudSignInTimeoutMs({ ORCA_CLOUD_SIGN_IN_TIMEOUT_MS: 'x' }, false)).toBe(300_000)
  })
})
