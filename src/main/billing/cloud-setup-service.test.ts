import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false }, shell: { openExternal: vi.fn() } }))

import {
  createSetupSessionRequest,
  getSetupSessionRequest,
  setupDeviceLabel,
  cloudSetupDeviceLabel
} from './cloud-setup-service'
import { cloudSetupStartArgsFromUnknown } from '../ipc/profiles/orca-profile-billing-handlers'

const endpoints = {
  billingApiUrl: 'https://billing.test',
  billingTokenEndpoint: 'https://auth.test/t'
}
const ID = 'cs_AAAAAAAAAAAAAAAAAAAAAA'

function fakeFetch(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify(body), { status })
  }
  return { impl, calls }
}

describe('cloud setup service', () => {
  it('creates a session with the billing token and returns its one-tab URL', async () => {
    const { impl, calls } = fakeFetch({
      id: ID,
      url: `https://auth-staging.onorca.dev/cloud/setup/start?session=${ID}&ticket=t`,
      expiresAt: 1
    })
    const created = await createSetupSessionRequest(
      endpoints,
      'tok',
      {
        repo: 'https://github.com/acme/web',
        needs: ['plan', 'github'],
        device: 'MacBook Pro',
        useActiveTeam: true
      },
      impl
    )
    expect(created.id).toBe(ID)
    expect(calls[0]!.url).toBe('https://billing.test/v1/cloud-setup/sessions')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      repo: 'https://github.com/acme/web',
      needs: ['plan', 'github'],
      device: 'MacBook Pro',
      useActiveTeam: true
    })
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer tok')
  })

  it('refuses a session URL that is not https', async () => {
    const { impl } = fakeFetch({ id: ID, url: 'http://evil.test/x', expiresAt: 1 })
    await expect(
      createSetupSessionRequest(
        endpoints,
        'tok',
        { needs: ['plan'], device: 'x', useActiveTeam: true },
        impl
      )
    ).rejects.toThrow('invalid_setup_session')
  })

  it('reads steps, team, trial and errors, dropping unknown error kinds', async () => {
    const { impl } = fakeFetch({
      id: ID,
      steps: [
        { id: 'account', state: 'done' },
        { id: 'team', state: 'done', detail: 'acme' },
        { id: 'plan', state: 'failed' }
      ],
      team: { orgId: 'org_1', name: 'acme', created: true },
      trial: null,
      plan: null,
      finished: false,
      error: { kind: 'something_new' },
      expiresAt: 5
    })
    const session = await getSetupSessionRequest(endpoints, 'tok', ID, impl)
    expect(session.steps).toHaveLength(3)
    expect(session.team).toEqual({ orgId: 'org_1', name: 'acme', created: true })
    expect(session.error).toBeNull()
  })

  it('labels the device from the host name', () => {
    expect(setupDeviceLabel('Neils-MacBook-Pro.local')).toBe('Neils MacBook Pro')
    expect(setupDeviceLabel('')).toBe('this computer')
  })

  it('names the Mac by its Computer Name, apostrophe included, and falls back to the hostname', async () => {
    const named = (name: string, final = true) => async () => ({ name, final })
    expect(
      await cloudSetupDeviceLabel({ platform: 'darwin', detect: named("m4air's MacBook Air") })
    ).toBe("m4air's MacBook Air")
    // scutil timed out or failed: the cleaned hostname, as before.
    expect(
      await cloudSetupDeviceLabel({ platform: 'darwin', detect: named('m4airs-MacBook-Air', false) })
    ).toBe(setupDeviceLabel())
    // Off macOS the hostname is the name.
    expect(
      await cloudSetupDeviceLabel({ platform: 'linux', detect: named('ignored') })
    ).toBe(setupDeviceLabel())
  })

  it('validates start args from the renderer', () => {
    expect(cloudSetupStartArgsFromUnknown({ needs: ['team', 'plan'], chooseTeam: true })).toEqual({
      needs: ['team', 'plan'],
      chooseTeam: true
    })
    expect(() =>
      cloudSetupStartArgsFromUnknown({ needs: ['team'], repo: 'https://gitlab.com/a/b' })
    ).toThrow()
    expect(() => cloudSetupStartArgsFromUnknown({ needs: ['bogus'] })).toThrow()
  })
})
