import { describe, expect, it, vi } from 'vitest'
import { ORCA_CLOUD_ENROLLMENT_UNAVAILABLE } from '../../shared/orca-cloud-device-enrollment-contract'
import { createHostedSandboxDeviceEnroller } from './hosted-sandbox-device-enrollment'

const session = {
  id: 'ds_AAAAAAAAAAAAAAAAAAAAAA',
  label: 'Phone',
  platform: 'ios',
  createdAt: 1,
  expiresAt: 2
}
const params = { label: 'Phone', platform: 'ios' as const, publicKeyB64: 'a'.repeat(44) }

function setup(responses: Response[]) {
  let minted = 0
  const config = {
    controlPlaneUrl: 'https://cp.test',
    getAccessToken: vi.fn(async () => `token-${minted}`),
    invalidateAccessToken: vi.fn(() => {
      minted++
    })
  }
  const bearers: string[] = []
  const fetchImpl: typeof fetch = async (_input, init) => {
    bearers.push(new Headers(init?.headers).get('authorization') ?? '')
    return responses.shift() ?? new Response(null, { status: 500 })
  }
  return { enroller: createHostedSandboxDeviceEnroller(config, fetchImpl), config, bearers }
}

describe('device enrollment', () => {
  it('mints a fresh token and retries once when the control plane says ours predates a role change', async () => {
    const { enroller, config, bearers } = setup([
      Response.json({ error: 'stale_token' }, { status: 403 }),
      Response.json({ deviceSession: session })
    ])
    await expect(enroller.enroll(params)).resolves.toMatchObject({
      deviceSession: { id: session.id }
    })
    expect(config.invalidateAccessToken).toHaveBeenCalledTimes(1)
    expect(bearers).toEqual(['Bearer token-0', 'Bearer token-1'])
  })

  it('does not retry other refusals, and gives up after one fresh try', async () => {
    const other = setup([Response.json({ error: 'forbidden' }, { status: 403 })])
    await expect(other.enroller.enroll(params)).rejects.toThrow(ORCA_CLOUD_ENROLLMENT_UNAVAILABLE)
    expect(other.config.invalidateAccessToken).not.toHaveBeenCalled()
    const twice = setup([
      Response.json({ error: 'stale_token' }, { status: 403 }),
      Response.json({ error: 'stale_token' }, { status: 403 })
    ])
    await expect(twice.enroller.enroll(params)).rejects.toThrow(ORCA_CLOUD_ENROLLMENT_UNAVAILABLE)
    expect(twice.bearers).toHaveLength(2)
  })
})
