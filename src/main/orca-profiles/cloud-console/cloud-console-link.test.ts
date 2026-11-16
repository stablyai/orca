import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false }, shell: { openExternal: vi.fn() } }))

import { CLOUD_CONSOLE_TICKET_PATH, cloudConsoleOrigin } from './cloud-console-config'
import {
  acceptedTicketUrl,
  advertisedConsoleOrigin,
  openedResult,
  cloudConsoleTicketBody,
  requestCloudConsoleTicket
} from './cloud-console-link'

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

  it('sends the billing hint only to an auth that advertises it, and only for billing', () => {
    const hint = { plan: 'team', interval: 'year' as const }
    const advertised = { capabilities: { flags: { 'console.billing_hint': true } } }
    expect(
      cloudConsoleTicketBody(advertised, { section: 'billing', orgId: 'org_1', billingHint: hint })
    ).toEqual({ page: 'billing', orgId: 'org_1', plan: 'team', interval: 'year' })
    expect(
      cloudConsoleTicketBody(
        { capabilities: { flags: {} } },
        { section: 'billing', orgId: 'org_1', billingHint: hint }
      )
    ).toEqual({ page: 'billing', orgId: 'org_1' })
    expect(
      cloudConsoleTicketBody(advertised, { section: 'team', orgId: 'org_1', billingHint: hint })
    ).toEqual({ page: 'team', orgId: 'org_1' })
  })

  it('asks for the API pages only from an auth that advertises them, with a team, else home', () => {
    const advertised = { capabilities: { flags: { 'console.cloud_api': true } } }
    for (const section of ['api', 'routines'] as const) {
      expect(cloudConsoleTicketBody(advertised, { section, orgId: 'org_1' })).toEqual({
        page: section,
        orgId: 'org_1'
      })
      expect(
        cloudConsoleTicketBody({ capabilities: { flags: {} } }, { section, orgId: null })
      ).toEqual({ page: 'home' })
      expect(cloudConsoleTicketBody({}, { section, orgId: null })).toEqual({ page: 'home' })
      // A personal account (no team): auth refuses the API pages without an orgId.
      expect(cloudConsoleTicketBody(advertised, { section, orgId: null })).toEqual({ page: 'home' })
    }
  })

  it('asks once more without the billing hint when auth refuses it', async () => {
    const seen: { url: string; init?: RequestInit }[] = []
    const answers = [
      Response.json({ error: 'invalid_request' }, { status: 400 }),
      Response.json({ url: 'https://login.onorca.dev/console/redeem?t=abc' })
    ]
    const fetchImpl: typeof fetch = async (url, init) => {
      seen.push({ url: String(url), init })
      return answers.shift()!
    }
    const url = await requestCloudConsoleTicket(
      config,
      {
        accessToken: 'at',
        capabilities: { flags: { 'console.billing_hint': true }, refreshedAt: 0 }
      },
      { section: 'billing', orgId: 'org_1', billingHint: { plan: 'team', interval: 'month' } },
      fetchImpl
    )
    expect(url).toBe('https://login.onorca.dev/console/redeem?t=abc')
    expect(seen.map((entry) => JSON.parse(String(entry.init?.body)))).toEqual([
      { page: 'billing', orgId: 'org_1', plan: 'team', interval: 'month' },
      { page: 'billing', orgId: 'org_1' }
    ])
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

  it('trusts only an https console origin from auth, and nothing but the origin', () => {
    expect(advertisedConsoleOrigin('https://console-staging.orca.dev')).toBe(
      'https://console-staging.orca.dev'
    )
    for (const bad of [
      'http://console-staging.orca.dev',
      'https://console-staging.orca.dev/console',
      'javascript:alert(1)',
      7,
      undefined
    ]) {
      expect(advertisedConsoleOrigin(bad)).toBeNull()
    }
  })

  it('tells a signed-in desktop why the console opened without a ticket', () => {
    const allowed = ['https://console-staging.orca.dev']
    const offSite = 'https://evil.example/console/redeem?t=abc'
    expect(
      openedResult({ url: offSite, attempted: true }, acceptedTicketUrl(offSite, allowed))
    ).toEqual({ status: 'opened', signedIn: false, ticketError: 'rejected' })
    expect(openedResult({ url: null, attempted: true }, null)).toEqual({
      status: 'opened',
      signedIn: false,
      ticketError: 'failed'
    })
    // Signed out (or dev auth): no ticket was asked for, so nothing went wrong.
    expect(openedResult({ url: null, attempted: false }, null)).toEqual({
      status: 'opened',
      signedIn: false
    })
    const ticket = 'https://console-staging.orca.dev/console/redeem?t=abc'
    expect(openedResult({ url: ticket, attempted: true }, ticket)).toEqual({
      status: 'opened',
      signedIn: true
    })
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
