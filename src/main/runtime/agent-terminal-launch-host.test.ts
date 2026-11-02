import { mergeWorktree } from '../ipc/worktree-metadata-merge'
import type { Repo } from '../../shared/repo-types'
// #11163: colliding repo ids on two hosts once selected the wrong launch settings.
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
  resolveGitWorktreeSelector: (selector: string) => Promise<unknown>
  buildStartupForAgent: (
    repo: unknown,
    agent: unknown,
    prompt: string,
    args?: unknown,
    options?: unknown
  ) => unknown
  createTerminal: (
    selector: string,
    opts: unknown,
    created?: unknown,
    resolved?: unknown
  ) => Promise<unknown>
}

function makeRuntime(
  repos: readonly Pick<Repo, 'id' | 'path' | 'connectionId'>[],
  hostId?: string
) {
  const store = {
    getSettings: () => ({ disabledTuiAgents: [], workspaceDir: '/tmp/workspaces' }),
    getProjectHostSetups: () => [],
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((repo) => repo.id === id)
  }
  const runtime = new OrcaRuntimeService(store as never)
  const internals = runtime as unknown as RuntimeInternals
  vi.spyOn(internals, 'resolveGitWorktreeSelector').mockResolvedValue({
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
  it('carries the resolved same-path target through launch scope and terminal creation', async () => {
    const local: Repo = {
      id: 'repo-shared',
      path: '/same',
      displayName: 'Local',
      addedAt: 1,
      badgeColor: '#000'
    }
    const remote: Repo = { ...local, connectionId: 'builder' }
    const { runtime, buildStartup } = makeRuntime([local, remote], 'ssh:builder')
    const git = { path: '/same', head: 'abc', branch: 'main', isMainWorktree: true, isBare: false }
    const worktree = {
      ...mergeWorktree(remote.id, git, undefined),
      hostId: 'ssh:builder' as const,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      git
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the private selector is replaced solely to prove the internal evidence prevents another lookup.
    const internals = runtime as unknown as RuntimeInternals
    vi.spyOn(internals, 'resolveGitWorktreeSelector').mockRejectedValue(
      new Error('bare selector was repeated')
    )
    await runtime.launchAgentTerminal(
      `id:${worktree.id}`,
      { agent: 'codex', prompt: 'Review' },
      { worktree, repo: remote }
    )
    expect(buildStartup.mock.calls[0]?.[0]).toEqual(remote)
    expect(buildStartup.mock.calls[0]?.[4]).toMatchObject({
      launchScope: { connectionId: 'builder', repo: remote, path: '/same' }
    })
    expect(internals.createTerminal).toHaveBeenCalledWith(
      `id:${worktree.id}`,
      expect.any(Object),
      undefined,
      worktree,
      undefined
    )
  })

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('builds the launch for the host the worktree names, not a rival row', async () => {
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
