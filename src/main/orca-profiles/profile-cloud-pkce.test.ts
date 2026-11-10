import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false }, shell: { openExternal: vi.fn() } }))

import type { OrcaCloudAuthConfig } from './profile-cloud-auth-config'
import { beginOrcaCloudPkceFlow } from './profile-cloud-pkce'

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
