// EP-9: getOrcaBillingStatus mints the billing token for the team this device's profile shows,
// from the same profile whose session it uses, and fails closed (billing_org_mismatch) otherwise.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp' }, shell: { openExternal: vi.fn() } }))

const profile: { id: string; cloud: { userId: string; activeOrgId: string | undefined } } = {
  id: 'p1',
  cloud: { userId: 'u1', activeOrgId: 'org_paid' }
}
vi.mock('../orca-profiles/profile-index-store', () => ({
  ensureActiveOrcaProfile: () => ({ profile })
}))
vi.mock('../orca-profiles/cloud-auth/profile-cloud-auth-config', () => ({
  getOrcaCloudAuthConfig: () => ({ configured: true, config: { apiBaseUrl: 'https://auth.test' } })
}))
vi.mock('./billing-config', () => ({
  getBillingEndpoints: () => ({ billingApiUrl: 'https://billing.test', billingTokenEndpoint: 'https://auth.test/v1/desktop/auth/billing-token' })
}))
vi.mock('./billing-dev-token', () => ({ getBillingDevKeyFile: () => null, mintDevBillingToken: vi.fn() }))
vi.mock('../orca-profiles/cloud-session/profile-cloud-session-refresh', () => ({
  runWithFreshOrcaCloudSession: async (_config: unknown, _active: unknown, _path: string, run: (session: { accessToken: string }) => Promise<unknown>) => ({
    status: 'ok',
    value: await run({ accessToken: 'access' })
  })
}))
const mint = vi.fn()
const fetchEntitlement = vi.fn()
vi.mock('./billing-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  mintBillingToken: (...args: unknown[]) => mint(...args),
  fetchEntitlement: (...args: unknown[]) => fetchEntitlement(...args)
}))

import { BillingOrgMismatchError } from './billing-client'
import { getOrcaBillingStatus } from './billing-service'

describe('EP-9: the billing token is for the team this device shows', () => {
  beforeEach(() => {
    mint.mockReset()
    fetchEntitlement.mockReset()
    profile.cloud.activeOrgId = 'org_paid'
  })

  it("passes the device profile's team (null for personal) to the mint", async () => {
    mint.mockResolvedValue('bt')
    fetchEntitlement.mockResolvedValue({ plan: 'team' })
    await getOrcaBillingStatus('/tmp')
    expect(mint.mock.calls[0]?.[2]).toBe('org_paid')
    profile.cloud.activeOrgId = undefined
    await getOrcaBillingStatus('/tmp')
    expect(mint.mock.calls[1]?.[2]).toBeNull()
  })

  it('fails closed with billing_org_mismatch (the screen says so), never another team\'s plan', async () => {
    mint.mockRejectedValue(new BillingOrgMismatchError('org_paid'))
    await expect(getOrcaBillingStatus('/tmp')).resolves.toEqual({ status: 'failed', error: 'billing_org_mismatch' })
    expect(fetchEntitlement).not.toHaveBeenCalled()
  })
})
