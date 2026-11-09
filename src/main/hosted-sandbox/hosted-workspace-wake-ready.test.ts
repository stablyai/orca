import { describe, expect, it, vi } from 'vitest'

const runtimes: { status: string; runtimeEnvironmentId?: string }[] = []
let listOk = true
vi.mock('../ipc/runtime-environments/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: vi.fn(async () =>
    listOk ? { ok: true, result: {} } : { ok: false, error: { code: 'x', message: 'x' } }
  )
}))
vi.mock('../../shared/ephemeral-vm-runtime-store', () => ({
  listEphemeralVmRuntimes: () =>
    runtimes.map((r) => ({
      ...r,
      workspaceId: 'ws',
      recipe: { provider: 'orca-cloud' },
      recipeResult: {
        schemaVersion: 1,
        pairingCode: 'x',
        projectRoot: '/p',
        orcaCloud: { sandboxId: 'sbx_1' }
      }
    }))
}))
vi.mock('../environment-providers/environment-provider-recipe-adapter', () => ({
  environmentHandleFromRecipeResult: () => ({ driverState: { sandboxId: 'sbx_1' } })
}))

describe('announceWakeUsable', () => {
  it('emits ready once running and reachable', async () => {
    const { announceWakeUsable } = await import('./hosted-workspace-runtime')
    runtimes.splice(0, runtimes.length, { status: 'running', runtimeEnvironmentId: 'env' })
    listOk = true
    const emit = vi.fn()
    await announceWakeUsable('/u', 'ws', 1, { isCurrent: () => true, emit }, 2_000)
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ phase: 'ready', startedAt: 1 }))
  })

  it('emits failed when the server never answers, and nothing for a superseded wake', async () => {
    const { announceWakeUsable } = await import('./hosted-workspace-runtime')
    runtimes.splice(0, runtimes.length, { status: 'running', runtimeEnvironmentId: 'env' })
    listOk = false
    const emit = vi.fn()
    await announceWakeUsable('/u', 'ws', 2, { isCurrent: () => true, emit }, 600)
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ phase: 'failed' }))
    const stale = vi.fn()
    await announceWakeUsable('/u', 'ws', 3, { isCurrent: () => false, emit: stale }, 600)
    expect(stale).not.toHaveBeenCalled()
  })
})
