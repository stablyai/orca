import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false }, shell: { openExternal: vi.fn() } }))

import { CLOUD_CONSOLE_TICKET_PATH, cloudConsoleOrigin } from './cloud-console-config'
import { acceptedTicketUrl, requestCloudConsoleTicket } from './cloud-console-link'

const config = { apiBaseUrl: 'https://login.onorca.dev' }

function fakeFetch(response: Response, seen: { url: string; init?: RequestInit }[] = []) {
  return vi.fn<typeof fetch>(async (url, init) => {
    seen.push({ url: String(url), init })
    return response
  })
}

describe('console origin', () => {
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
})

describe('console ticket', () => {
  it('posts the page and team with the access token, and never follows redirects', async () => {
    const seen: { url: string; init?: RequestInit }[] = []
    const ticket = 'https://login.onorca.dev/console/redeem?t=abc'
    const url = await requestCloudConsoleTicket(
      config,
      { accessToken: 'at' },
      { section: 'enterprise', orgId: 'org_1' },
      fakeFetch(Response.json({ url: ticket, expiresAt: 1 }), seen)
    )
    expect(url).toBe(ticket)
    expect(seen[0]?.url).toBe(`https://login.onorca.dev${CLOUD_CONSOLE_TICKET_PATH}`)
    expect(seen[0]?.init?.method).toBe('POST')
    expect(seen[0]?.init?.redirect).toBe('error')
    expect(new Headers(seen[0]?.init?.headers).get('authorization')).toBe('Bearer at')
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ page: 'enterprise', orgId: 'org_1' })
  })

  it('leaves out the team for a personal account', async () => {
    const seen: { url: string; init?: RequestInit }[] = []
    await requestCloudConsoleTicket(
      config,
      { accessToken: 'at' },
      { section: 'billing', orgId: null },
      fakeFetch(Response.json({ url: 'x' }), seen)
    )
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ page: 'billing' })
  })

  it('throws on a refusal so the console opens without a ticket', async () => {
    await expect(
      requestCloudConsoleTicket(
        config,
        { accessToken: 'at' },
        { section: 'team', orgId: null },
        fakeFetch(Response.json({ error: 'recent_sign_in_required' }, { status: 403 }))
      )
    ).rejects.toMatchObject({ statusCode: 403, errorCode: 'recent_sign_in_required' })
  })

  it('opens only a ticket URL on the console or auth origin', () => {
    const allowed = ['https://console.onorca.dev', 'https://login.onorca.dev']
    const ticket = 'https://login.onorca.dev/console/redeem?t=abc'
    expect(acceptedTicketUrl(ticket, allowed)).toBe(ticket)
    for (const bad of [
      'https://evil.example/console/redeem?t=abc',
      'javascript:alert(1)',
      'https://user:pw@login.onorca.dev/console',
      '',
      7,
      null
    ]) {
      expect(acceptedTicketUrl(bad, allowed)).toBeNull()
    }
  })
})
