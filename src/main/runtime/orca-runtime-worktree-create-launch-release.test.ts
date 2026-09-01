// Regression (L4-M1): a two-stage worktree-create launch reserves admission
// capacity BEFORE git runs. Any throw between that stage-1 reservation and a
// settled finish() (branch conflict, SSH drop, `git worktree add` failure) must
// release the reservation — reservations have no TTL and are invisible to
// reconcile/Forget, so a leak wedges launches at the per-principal cap until
// restart. This drives createManagedWorktree's release-on-throw seam directly.

import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { WorktreeAgentLaunchPreCreateError } from '../agent-launch/agent-launch-worktree-resolution'
import type { CreatedWorktreeResult } from '../../shared/types'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

type RuntimeInternals = {
  store: unknown
  resolveRepoSelector: (selector: string) => Promise<unknown>
  prepareWorktreeCreateAgentLaunch: (...args: unknown[]) => Promise<unknown>
  createManagedWorktreeAfterLaunchPrepare: (...args: unknown[]) => Promise<CreatedWorktreeResult>
}

function makeRuntime(): { runtime: OrcaRuntimeService; internals: RuntimeInternals } {
  const runtime = new OrcaRuntimeService()
  const internals = runtime as unknown as RuntimeInternals
  internals.store = { getSettings: () => ({ disabledTuiAgents: [] }) }
  vi.spyOn(internals, 'resolveRepoSelector').mockResolvedValue({ id: 'r1', path: '/repo' })
  return { runtime, internals }
}

const ARGS = {
  repoSelector: 'r1',
  name: 'feature',
  agentLaunch: { selection: { kind: 'default' as const }, allowEmptyPromptLaunch: true }
}

describe('createManagedWorktree stage-1 reservation lifecycle', () => {
  it('releases the held reservation when creation throws after prepare', async () => {
    const { runtime, internals } = makeRuntime()
    const release = vi.fn()
    vi.spyOn(internals, 'prepareWorktreeCreateAgentLaunch').mockResolvedValue({
      ok: true,
      release,
      finish: vi.fn()
    })
    vi.spyOn(internals, 'createManagedWorktreeAfterLaunchPrepare').mockRejectedValue(
      new Error('git worktree add failed')
    )

    await expect(runtime.createManagedWorktree(ARGS)).rejects.toThrow('git worktree add failed')
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('does not release when creation succeeds (finish owns the reservation)', async () => {
    const { runtime, internals } = makeRuntime()
    const release = vi.fn()
    vi.spyOn(internals, 'prepareWorktreeCreateAgentLaunch').mockResolvedValue({
      ok: true,
      release,
      finish: vi.fn()
    })
    vi.spyOn(internals, 'createManagedWorktreeAfterLaunchPrepare').mockResolvedValue({
      worktree: {}
    } as CreatedWorktreeResult)

    await runtime.createManagedWorktree(ARGS)
    expect(release).not.toHaveBeenCalled()
  })

  it('a stage-1 rejection creates nothing and throws the pre-create error', async () => {
    const { runtime, internals } = makeRuntime()
    vi.spyOn(internals, 'prepareWorktreeCreateAgentLaunch').mockResolvedValue({
      ok: false,
      failure: { code: 'launch_capacity_exceeded', reason: 'capacity' }
    })
    const body = vi.spyOn(internals, 'createManagedWorktreeAfterLaunchPrepare')

    await expect(runtime.createManagedWorktree(ARGS)).rejects.toBeInstanceOf(
      WorktreeAgentLaunchPreCreateError
    )
    expect(body).not.toHaveBeenCalled()
  })
})
