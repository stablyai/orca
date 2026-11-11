import { describe, expect, it, vi } from 'vitest'

const runtimes = vi.hoisted((): { list: unknown[] } => ({ list: [] }))
vi.mock('../../shared/ephemeral-vm-runtime-store', () => ({
  listEphemeralVmRuntimes: () => runtimes.list
}))
vi.mock('../environment-providers/environment-provider-recipe-adapter', () => ({
  environmentHandleFromRecipeResult: (result: { sandboxId?: string } | undefined) =>
    result?.sandboxId ? { environmentId: result.sandboxId } : null
}))

const { orcaCloudSandboxIdFor } = await import('./orca-cloud-sandbox-id')

describe('orcaCloudSandboxIdFor', () => {
  it('resolves composer-created cloud workspaces whose recipe has no provider (RA-11)', () => {
    runtimes.list = [
      {
        runtimeEnvironmentId: 'env-a',
        recipe: { id: 'cloud' },
        recipeResult: { sandboxId: 'sbx_a' }
      },
      {
        runtimeEnvironmentId: 'env-b',
        recipe: { id: 'cloud', provider: 'orca-cloud' },
        recipeResult: { sandboxId: 'sbx_b' }
      }
    ]
    expect(orcaCloudSandboxIdFor('/u', 'env-a')).toBe('sbx_a')
    expect(orcaCloudSandboxIdFor('/u', 'env-b')).toBe('sbx_b')
  })

  it('never resolves another provider, an unknown runtime, or one without a hosted-sandbox handle', () => {
    runtimes.list = [
      {
        runtimeEnvironmentId: 'env-c',
        recipe: { provider: 'custom' },
        recipeResult: { sandboxId: 'x' }
      },
      { runtimeEnvironmentId: 'env-d', recipe: { id: 'cloud' }, recipeResult: {} }
    ]
    expect(orcaCloudSandboxIdFor('/u', 'env-c')).toBeNull()
    expect(orcaCloudSandboxIdFor('/u', 'env-d')).toBeNull()
    expect(orcaCloudSandboxIdFor('/u', 'env-zzz')).toBeNull()
  })
})
