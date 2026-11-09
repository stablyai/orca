import { describe, expect, it } from 'vitest'
import { parseEphemeralVmRecipeResult } from '../../shared/ephemeral-vm-recipes'
import { isEnvironmentProviderError } from '../environment-providers/environment-provider-driver'
import { runEnvironmentProviderDriverContract } from '../environment-providers/environment-provider-driver-contract.test-support'
import {
  environmentHandleFromRecipeResult,
  environmentReadyToRecipeResult
} from '../environment-providers/environment-provider-recipe-adapter'
import { createHostedSandboxControlPlaneClient } from './hosted-sandbox-control-plane-client'
import { createHostedSandboxDriver, HOSTED_SANDBOX_DRIVER_ID } from './hosted-sandbox-driver'
import { createFakeHostedControlPlane } from './fake-hosted-control-plane.test-support'

function setup(options: { token?: string; fetch?: typeof fetch } = {}) {
  const plane = createFakeHostedControlPlane()
  const client = createHostedSandboxControlPlaneClient({
    baseUrl: 'https://sandbox.cloud.test',
    getAccessToken: async () => options.token ?? plane.token,
    fetch: options.fetch ?? plane.fetch
  })
  return { plane, client, driver: createHostedSandboxDriver(client) }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error
  )
}

runEnvironmentProviderDriverContract('HostedSandboxDriver', async () => {
  const { plane, client, driver } = setup()
  return {
    driver,
    reopenDriver: () => createHostedSandboxDriver(client),
    liveEnvironmentIds: async () =>
      [...plane.sandboxes.values()].filter((s) => s.status !== 'destroyed').map((s) => s.id)
  }
})

describe('HostedSandboxDriver', () => {
  it('surfaces the billing deny reason when Orca Cloud refuses a start', async () => {
    const { plane, driver } = setup()
    plane.denyNextStart('included_hours_exhausted')
    const error = await rejection(driver.create({ workspaceId: 'ws-1' }))
    expect(isEnvironmentProviderError(error, 'entitlement_denied')).toBe(true)
    expect(isEnvironmentProviderError(error) && error.reason).toBe('included_hours_exhausted')
  })

  it('sends only the Orca token and maps a rejected token to unauthorized', async () => {
    const { plane, driver } = setup({ token: 'expired' })
    const error = await rejection(driver.create({ workspaceId: 'ws-1' }))
    expect(isEnvironmentProviderError(error, 'unauthorized')).toBe(true)
    expect(plane.requests.map((r) => r.authorization)).toEqual(['Bearer expired'])
  })

  it('does not follow redirects, so the bearer token cannot be forwarded off-origin', async () => {
    const seen: RequestInit[] = []
    const { driver } = setup({
      fetch: async (_input, init) => {
        seen.push(init ?? {})
        return new Response(null, { status: 302, headers: { location: 'https://evil.test/' } })
      }
    })
    const error = await rejection(driver.create({ workspaceId: 'ws-1' }))
    expect(isEnvironmentProviderError(error, 'invalid_response')).toBe(true)
    expect(seen[0]?.redirect).toBe('manual')
  })

  it('rejects a success payload that does not match the wire contract', async () => {
    const { driver } = setup({ fetch: async () => Response.json({ sandbox: { id: 'x' } }) })
    const error = await rejection(driver.create({ workspaceId: 'ws-1' }))
    expect(isEnvironmentProviderError(error, 'invalid_response')).toBe(true)
  })

  it('refuses a plain-HTTP control plane outside loopback', () => {
    expect(() =>
      createHostedSandboxControlPlaneClient({
        baseUrl: 'http://sandbox.cloud.test',
        getAccessToken: async () => 't'
      })
    ).toThrow(/HTTPS/)
  })

  it('round-trips through the recipe result the runtime record stores', async () => {
    const { driver } = setup()
    const ready = await driver.create({ workspaceId: 'ws-1' })
    const recipeResult = environmentReadyToRecipeResult(ready, 'provisioned-root')
    const parsed = parseEphemeralVmRecipeResult(JSON.stringify(recipeResult))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) {
      return
    }
    expect(environmentHandleFromRecipeResult(parsed.result, HOSTED_SANDBOX_DRIVER_ID)).toEqual(
      ready.handle
    )
    expect(environmentHandleFromRecipeResult(parsed.result, 'shell-recipe')).toBeNull()
    expect((await driver.resume(ready.handle)).handle.environmentId).toBe(
      ready.handle.environmentId
    )
  })
})
