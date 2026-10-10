import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { readWorkerCodexDiscoveredEfforts } from './worker-codex-effort-preflight'

function runtime(read: OrcaRuntimeService['readOrchestrationCodexModelEfforts']) {
  return { readOrchestrationCodexModelEfforts: vi.fn(read) }
}

function call(
  host: ReturnType<typeof runtime>,
  params: { agent?: string; model?: string; effort?: string },
  resolveTarget = async () => ({ worktree: 'id:wt-1' })
) {
  return readWorkerCodexDiscoveredEfforts(host, params, resolveTarget)
}

describe('readWorkerCodexDiscoveredEfforts', () => {
  it('asks the worker host for a Codex model effort list', async () => {
    const host = runtime(async () => ['low', 'max'])
    await expect(
      call(host, { agent: 'codex', model: 'gpt-6.1-sol', effort: 'max' })
    ).resolves.toEqual(['low', 'max'])
    expect(host.readOrchestrationCodexModelEfforts).toHaveBeenCalledWith(
      { worktree: 'id:wt-1' },
      'gpt-6.1-sol'
    )
  })

  it.each([
    { agent: 'claude', model: 'opus', effort: 'max' },
    { agent: 'codex', model: 'gpt-6.1-sol' },
    { agent: 'codex', effort: 'max' }
  ])('does not list models for %j', async (params) => {
    const host = runtime(async () => ['low'])
    const resolveTarget = vi.fn(async () => ({ worktree: 'id:wt-1' }))
    await expect(call(host, params, resolveTarget)).resolves.toBeNull()
    expect(resolveTarget).not.toHaveBeenCalled()
    expect(host.readOrchestrationCodexModelEfforts).not.toHaveBeenCalled()
  })

  it('leaves placement errors to worker-start and falls back to the static catalog', async () => {
    const host = runtime(async () => ['low'])
    await expect(
      call(host, { agent: 'codex', model: 'gpt-6.1-sol', effort: 'max' }, async () => {
        throw new Error('worktree not found')
      })
    ).resolves.toBeNull()
  })
})
