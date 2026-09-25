// launchAgentTerminal read `store.getRepo(worktree.repoId)?.connectionId` for the trust write —
// host-blind, so the same repo id on two hosts wrote a remote path into the client's agent config
// and the agent on the host never saw the trust (#11163). Every sibling call site already passes
// the resolved `workspace.connectionId`; this was the last one that did not.
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
  markWorkspaceTrustedForAgent: (
    agent: unknown,
    connectionId: string | null | undefined,
    path: string
  ) => Promise<void>
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
  vi.spyOn(internals, 'buildStartupForAgent').mockReturnValue({
    agent: 'codex',
    startup: { command: 'codex', env: {}, startupCommandDelivery: 'none', telemetry: {} }
  })
  const markTrusted = vi.fn(async () => {})
  vi.spyOn(internals, 'markWorkspaceTrustedForAgent').mockImplementation(markTrusted)
  vi.spyOn(internals, 'createTerminal').mockResolvedValue({ id: 'pty-1' })
  return { runtime, markTrusted }
}

describe('launchAgentTerminal trust write', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('writes trust on the host the worktree names, not on a rival row', async () => {
    // Two SSH hosts publish the same repo id; the worktree is on m4air.
    const { runtime, markTrusted } = makeRuntime(
      [
        { id: 'repo-shared', path: '/home/me/app', connectionId: 'openclaw' },
        { id: 'repo-shared', path: '/srv/app', connectionId: 'm4air' }
      ],
      'ssh:m4air'
    )

    await runtime.launchAgentTerminal('id:repo-shared::/srv/app-feature', {
      agent: 'codex',
      prompt: 'go'
    } as never)

    expect(markTrusted).toHaveBeenCalledWith('codex', 'm4air', REMOTE_PATH)
  })

  it('writes trust locally for a local worktree even when a remote row shares the id', async () => {
    const { runtime, markTrusted } = makeRuntime(
      [
        { id: 'repo-shared', path: '/srv/app', connectionId: 'm4air' },
        { id: 'repo-shared', path: '/home/me/app' }
      ],
      'local'
    )

    await runtime.launchAgentTerminal('id:repo-shared::/srv/app-feature', {
      agent: 'codex',
      prompt: 'go'
    } as never)

    expect(markTrusted).toHaveBeenCalledWith('codex', null, REMOTE_PATH)
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
      } as never)
    ).rejects.toThrow('worktree_execution_host_unresolved')
  })
})
