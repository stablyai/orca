// launchAgentTerminal once read the host-blind `store.getRepo(worktree.repoId)`, so the same repo
// id on two hosts built the launch for the wrong one (#11163).
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
}))

import { OrcaRuntimeService } from './orca-runtime'

const REMOTE_PATH = '/srv/app-feature'

type RuntimeInternals = {
  resolveWorktreeSelector: (selector: string) => Promise<unknown>
  buildStartupForAgent: (repo: unknown, agent: unknown, prompt: string) => unknown
  createTerminal: (selector: string, opts: unknown) => Promise<unknown>
}

function makeRuntime(repos: readonly Record<string, unknown>[], hostId?: string) {
  const store = {
    getSettings: () => ({ disabledTuiAgents: [], workspaceDir: '/tmp/workspaces' }),
    getProjectHostSetups: () => [],
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((repo) => repo.id === id)
  }
  const runtime = new OrcaRuntimeService(store as never)
  const internals = runtime as unknown as RuntimeInternals
  vi.spyOn(internals, 'resolveWorktreeSelector').mockResolvedValue({
    id: 'repo-shared::/srv/app-feature',
    repoId: 'repo-shared',
    path: REMOTE_PATH,
    ...(hostId ? { hostId } : {})
  })
  const buildStartup = vi.spyOn(internals, 'buildStartupForAgent').mockReturnValue({
    agent: 'codex',
    startup: { command: 'codex', env: {}, startupCommandDelivery: 'none', telemetry: {} }
  })
  vi.spyOn(internals, 'createTerminal').mockResolvedValue({ id: 'pty-1' })
  return { runtime, buildStartup }
}

describe('launchAgentTerminal execution host', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('builds the launch for the host the worktree names, not a rival row', async () => {
    // Two SSH hosts publish the same repo id; the worktree is on m4air.
    const { runtime, buildStartup } = makeRuntime(
      [
        { id: 'repo-shared', path: '/home/me/app', connectionId: 'openclaw' },
        { id: 'repo-shared', path: '/srv/app', connectionId: 'm4air' }
      ],
      'ssh:m4air'
    )

    await runtime.launchAgentTerminal('id:repo-shared::/srv/app-feature', {
      agent: 'codex',
      prompt: 'go'
    })

    expect(buildStartup.mock.calls[0]?.[0]).toMatchObject({ connectionId: 'm4air' })
  })

  it('builds a local launch for a local worktree even when a remote row shares the id', async () => {
    const { runtime, buildStartup } = makeRuntime(
      [
        { id: 'repo-shared', path: '/srv/app', connectionId: 'm4air' },
        { id: 'repo-shared', path: '/home/me/app' }
      ],
      'local'
    )

    await runtime.launchAgentTerminal('id:repo-shared::/srv/app-feature', {
      agent: 'codex',
      prompt: 'go'
    })

    expect(buildStartup.mock.calls[0]?.[0]).toMatchObject({ path: '/home/me/app' })
    expect(buildStartup.mock.calls[0]?.[0]).not.toHaveProperty('connectionId')
  })

  it('refuses rather than guessing when rival rows disagree and the worktree names no host', async () => {
    const { runtime } = makeRuntime([
      { id: 'repo-shared', path: '/srv/app', connectionId: 'm4air' },
      { id: 'repo-shared', path: '/home/me/app' }
    ])

    await expect(
      runtime.launchAgentTerminal('id:repo-shared::/srv/app-feature', {
        agent: 'codex',
        prompt: 'go'
      })
    ).rejects.toThrow('worktree_execution_host_unresolved')
  })
})
