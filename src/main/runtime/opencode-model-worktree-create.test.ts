import { beforeEach, describe, expect, it, vi } from 'vitest'

const resolveRepo = vi.hoisted(() => vi.fn())
vi.mock('./orca-runtime-get-worktree-terminal-provisioning-host', () => ({
  OrcaRuntimeWithGetWorktreeTerminalProvisioningHost: class {
    store = { getSettings: () => ({ disabledTuiAgents: [] }) }
    resolveRepoSelector = resolveRepo
  }
}))
vi.mock('../workspace-create-telemetry', () => ({
  trackRuntimeWorkspaceCreate: (
    _request: unknown,
    execute: (events: { begin: ReturnType<typeof vi.fn> }) => Promise<unknown>
  ) => execute({ begin: vi.fn() })
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/private/test', isPackaged: false },
  BrowserWindow: { fromId: vi.fn() },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() }
}))

import { OrcaRuntimeWithCreateManagedWorktree } from './orca-runtime-create-managed-worktree'

describe('unverified OpenCode model worktree creation', () => {
  beforeEach(() => {
    resolveRepo.mockReset()
    resolveRepo.mockRejectedValue(new Error('repo_read_before_model_refusal'))
  })

  it.each(['local-repo', 'folder-repo', 'ssh-repo'])(
    'refuses %s before resolving or creating its workspace',
    async (repoSelector) => {
      const runtime = new OrcaRuntimeWithCreateManagedWorktree()
      await expect(
        runtime.createManagedWorktree({
          repoSelector,
          name: 'unverified-model',
          startupAgent: 'opencode',
          startupLaunchPreferences: { model: 'private-proof/model-b' }
        })
      ).rejects.toMatchObject({ code: 'capability_unsupported' })
      expect(resolveRepo).not.toHaveBeenCalled()
    }
  )

  it('preserves worktree creation without a model preference', async () => {
    const runtime = new OrcaRuntimeWithCreateManagedWorktree()
    await expect(
      runtime.createManagedWorktree({
        repoSelector: 'local-repo',
        name: 'ordinary',
        startupAgent: 'opencode'
      })
    ).rejects.toThrow('repo_read_before_model_refusal')
    expect(resolveRepo).toHaveBeenCalledOnce()
  })
})
