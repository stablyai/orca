import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaCloudAuthConfig } from './profile-cloud-auth-config'
import { createOrcaCloudProfile, OrcaCloudRequestError } from './profile-cloud-client'
import type { OrcaCloudSession } from './profile-cloud-session-store'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createOrcaCloudProfile', () => {
  it('proves the sign-in with its refresh token alongside the access token', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>(
      async () => new Response(null, { status: 403 })
    )
    vi.stubGlobal('fetch', fetchImpl)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the call reads only this endpoint.
    const config = {
      profileEndpoint: 'https://login.test/v1/desktop/auth/profile'
    } as OrcaCloudAuthConfig
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the call reads only the two tokens.
    const session = { accessToken: 'access-1', refreshToken: 'refresh-1' } as OrcaCloudSession

    await expect(
      createOrcaCloudProfile(config, session, { orgId: 'org-1', name: 'Work' })
    ).rejects.toBeInstanceOf(OrcaCloudRequestError)

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://login.test/v1/desktop/auth/profile')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer access-1')
    expect(JSON.parse(String(init?.body))).toEqual({
      orgId: 'org-1',
      name: 'Work',
      refreshToken: 'refresh-1'
    })
  })
})
