import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseEphemeralVmRecipeResult } from '../../shared/ephemeral-vm-recipes'
import { buildEphemeralVmRecipeLifecyclePayload } from '../../shared/ephemeral-vm-recipe-lifecycle-payload'
import { createHostedSandboxControlPlaneClient } from './hosted-sandbox-control-plane-client'
import { createHostedSandboxDriver } from './hosted-sandbox-driver'
import { ORCA_CLOUD_RECIPE, createHostedSandboxStepProvider } from './hosted-sandbox-recipe'
import { createFakeHostedControlPlane } from './fake-hosted-control-plane.test-support'

function setup() {
  const plane = createFakeHostedControlPlane()
  const driver = createHostedSandboxDriver(
    createHostedSandboxControlPlaneClient({
      baseUrl: 'https://sandbox.cloud.test',
      getAccessToken: async () => plane.token,
      fetch: plane.fetch
    })
  )
  return { plane, step: createHostedSandboxStepProvider(driver) }
}

const repoPath = mkdtempSync(join(tmpdir(), 'orca-cloud-recipe-'))
const context = { recipeId: 'cloud', repoPath, instanceId: 'orca-inst-1' }

describe('Orca Cloud built-in recipe steps', () => {
  it('answers create and resume with recipe results the runtime pipeline accepts', async () => {
    const { plane, step } = setup()
    const created = await step({ mode: 'create', repoPath, context })
    expect(created.exitCode).toBe(0)
    const parsed = parseEphemeralVmRecipeResult(created.stdout)
    expect(parsed.ok).toBe(true)
    expect([...plane.sandboxes.values()].map((s) => s.workspaceId)).toEqual(['orca-inst-1'])
    if (!parsed.ok) {
      return
    }
    const payload = (mode: 'suspend' | 'resume' | 'destroy') =>
      JSON.stringify(
        buildEphemeralVmRecipeLifecyclePayload({
          mode,
          recipe: ORCA_CLOUD_RECIPE,
          context,
          recipeResult: parsed.result
        })
      )
    expect(
      (await step({ mode: 'suspend', repoPath, context, stdin: payload('suspend') })).exitCode
    ).toBe(0)
    const resumed = await step({ mode: 'resume', repoPath, context, stdin: payload('resume') })
    expect(parseEphemeralVmRecipeResult(resumed.stdout).ok).toBe(true)
    expect(
      (await step({ mode: 'destroy', repoPath, context, stdin: payload('destroy') })).exitCode
    ).toBe(0)
    expect([...plane.sandboxes.values()].map((s) => s.status)).toEqual(['destroyed'])
  })

  it('turns a billing refusal into the plan upsell failure', async () => {
    const { plane, step } = setup()
    plane.denyNextStart('no_subscription')
    const result = await step({ mode: 'create', repoPath, context })
    expect(result.exitCode).toBe(1)
    expect(result.failure?.errorCode).toBe('cloudPlanRequired')
  })

  it('tells the user to free a slot, not to buy a plan, when the member is at their cap', async () => {
    const { plane, step } = setup()
    plane.denyNextStart('member_concurrency_limit')
    expect((await step({ mode: 'create', repoPath, context })).failure?.errorCode).toBe(
      'cloudConcurrencyLimit'
    )
  })
})
