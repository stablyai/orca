import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false }, shell: { openExternal: vi.fn() } }))

import {
  CLOUD_CONSOLE_CODE_PATH,
  cloudConsoleOrigin,
  cloudConsolePageUrl
} from './cloud-console-config'
import { requestCloudConsoleCode } from './cloud-console-link'

const config = { apiBaseUrl: 'https://login.onorca.dev' }

function fakeFetch(response: Response, seen: { url: string; init?: RequestInit }[] = []) {
  return vi.fn<typeof fetch>(async (url, init) => {
    seen.push({ url: String(url), init })
    return response
  })
}

describe('console page URL', () => {
  it('is the auth origin unless ORCA_CLOUD_CONSOLE_URL names another', () => {
    expect(cloudConsoleOrigin(config, {}, false)).toBe('https://login.onorca.dev')
    expect(
      cloudConsoleOrigin(config, { ORCA_CLOUD_CONSOLE_URL: 'https://console.staging.dev' }, false)
    ).toBe('https://console.staging.dev')
    // Plain http only in development builds.
    expect(
      cloudConsoleOrigin(config, { ORCA_CLOUD_CONSOLE_URL: 'http://127.0.0.1:8787' }, false)
    ).toBe('https://login.onorca.dev')
    expect(
      cloudConsoleOrigin(config, { ORCA_CLOUD_CONSOLE_URL: 'http://127.0.0.1:8787' }, true)
    ).toBe('http://127.0.0.1:8787')
  })

  it('carries the code only when there is one', () => {
    expect(cloudConsolePageUrl('https://login.onorca.dev', 'billing', 'c0de/+')).toBe(
      'https://login.onorca.dev/console/billing?code=c0de%2F%2B'
    )
    expect(cloudConsolePageUrl('https://login.onorca.dev', 'team', null)).toBe(
      'https://login.onorca.dev/console/team'
    )
  })
})

describe('console code request', () => {
  it('posts the page and team with the access token, and never follows redirects', async () => {
    const seen: { url: string; init?: RequestInit }[] = []
    const code = await requestCloudConsoleCode(
      config,
      { accessToken: 'at' },
      { section: 'enterprise', orgId: 'org_1' },
      fakeFetch(Response.json({ code: 'one-time' }), seen)
    )
    expect(code).toBe('one-time')
    expect(seen[0]?.url).toBe(`https://login.onorca.dev${CLOUD_CONSOLE_CODE_PATH}`)
    expect(seen[0]?.init?.method).toBe('POST')
    expect(seen[0]?.init?.redirect).toBe('error')
    expect(new Headers(seen[0]?.init?.headers).get('authorization')).toBe('Bearer at')
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ page: 'enterprise', orgId: 'org_1' })
  })

  it('leaves out the team for a personal account', async () => {
    const seen: { url: string; init?: RequestInit }[] = []
    await requestCloudConsoleCode(
      config,
      { accessToken: 'at' },
      { section: 'billing', orgId: null },
      fakeFetch(Response.json({ code: 'x' }), seen)
    )
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ page: 'billing' })
  })

  it('answers no code for a malformed answer and throws on a refusal', async () => {
    for (const body of [{}, { code: '' }, { code: 7 }, null]) {
      await expect(
        requestCloudConsoleCode(
          config,
          { accessToken: 'at' },
          { section: 'team', orgId: null },
          fakeFetch(Response.json(body))
        )
      ).resolves.toBeNull()
    }
    await expect(
      requestCloudConsoleCode(
        config,
        { accessToken: 'at' },
        { section: 'team', orgId: null },
        fakeFetch(Response.json({ error: 'recent_sign_in_required' }, { status: 403 }))
      )
    ).rejects.toMatchObject({ statusCode: 403, errorCode: 'recent_sign_in_required' })
  })
})
