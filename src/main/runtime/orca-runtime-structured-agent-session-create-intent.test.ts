import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { AssertClaudeBoundHomeUsable } from '../claude/claude-bound-home-refusal'

/** The real Store always answers these; a stub that omits one refuses by name instead of
 *  silently reading as "nothing is bound". */
const EMPTY_BINDING_CATALOG = {
  hasHydratedProjectCatalog: () => true,
  getProjectGroups: () => [],
  getRepos: () => [],
  getFolderWorkspaces: () => []
}

describe('structured agent-session create intent', () => {
  it('pins the selected Codex launch home after normal launch preparation', async () => {
    const prepareCodexStructuredLaunch = vi.fn(() => '/accounts/selected/home')
    const runtime = new OrcaRuntimeService(
      {
        getSettings: () => ({
          agentDefaultEnv: { codex: { CODEX_HOME: '/configured/home' } },
          nativeChatSessionOptions: {
            codex: {
              model: 'gpt-5.6-sol',
              valuesByModel: {
                'gpt-5.6-sol': { effort: 'medium', fastMode: true, personality: 'concise' }
              }
            }
          }
        })
      } as never,
      undefined,
      { prepareCodexStructuredLaunch }
    )
    vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
      supported: true
    })
    const internal = runtime as unknown as {
      resolveStructuredAgentSessionLocation: (selector: string) => Promise<{
        executionHostId: string
        wslDistro: null
        workspaceId: string
        workspaceKind: 'git-worktree'
      }>
      resolveRuntimeFileTarget: (selector: string) => Promise<{
        worktree: { path: string }
      }>
    }
    internal.resolveStructuredAgentSessionLocation = vi.fn(async () => ({
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree' as const
    }))
    internal.resolveRuntimeFileTarget = vi.fn(async () => ({
      worktree: { path: '/repos/workspace-1' }
    }))

    const intent = await runtime.resolveStructuredAgentSessionCreateIntent({
      envelope: { sessionId: 'session-1', clientOperationId: 'operation-1' },
      worktree: 'id:workspace-1',
      agent: 'codex'
    })

    expect(prepareCodexStructuredLaunch).toHaveBeenCalledWith({
      workspacePath: '/repos/workspace-1',
      launchEnv: expect.objectContaining({ CODEX_HOME: '/configured/home' })
    })
    expect(intent.accountHome).toEqual({
      variable: 'CODEX_HOME',
      path: '/accounts/selected/home'
    })
    expect(intent.options).toEqual({ model: 'gpt-5.6-sol', effort: 'medium', fastMode: 'true' })
  })

  it('pins the configured Claude launch home without Codex launch preparation', async () => {
    const prepareCodexStructuredLaunch = vi.fn()
    const runtime = new OrcaRuntimeService(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the create-intent path reads only the store accessors stubbed here.
      {
        ...EMPTY_BINDING_CATALOG,
        getSettings: () => ({
          agentDefaultEnv: {
            claude: { CLAUDE_CONFIG_DIR: '/configured/claude-home' }
          },
          nativeChatSessionOptions: {
            claude: {
              model: 'opus',
              valuesByModel: { opus: { effort: 'high', fastMode: true } }
            }
          }
        })
      } as never,
      undefined,
      { prepareCodexStructuredLaunch }
    )
    vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
      supported: true
    })
    const internal = runtime as unknown as {
      resolveStructuredAgentSessionLocation: (selector: string) => Promise<{
        executionHostId: string
        wslDistro: null
        workspaceId: string
        workspaceKind: 'git-worktree'
      }>
      resolveRuntimeFileTarget: (selector: string) => Promise<{
        worktree: { path: string }
      }>
    }
    internal.resolveStructuredAgentSessionLocation = vi.fn(async () => ({
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree' as const
    }))
    internal.resolveRuntimeFileTarget = vi.fn(async () => ({
      worktree: { path: '/repos/workspace-1' }
    }))

    const intent = await runtime.resolveStructuredAgentSessionCreateIntent({
      envelope: { sessionId: 'session-1', clientOperationId: 'operation-1' },
      worktree: 'id:workspace-1',
      agent: 'claude'
    })

    expect(prepareCodexStructuredLaunch).not.toHaveBeenCalled()
    expect(intent.accountHome).toEqual({
      variable: 'CLAUDE_CONFIG_DIR',
      path: '/configured/claude-home'
    })
    expect(intent.options).toEqual({ model: 'opus', effort: 'high', fastMode: 'true' })
  })

  it('uses the managed Claude launch home before falling back to ~/.claude', async () => {
    const prepareCodexStructuredLaunch = vi.fn()
    const getRuntimeConfigDir = vi.fn(() => '/accounts/managed/claude-home')
    const runtime = new OrcaRuntimeService(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the create-intent path reads only the store accessors stubbed here.
      {
        ...EMPTY_BINDING_CATALOG,
        getSettings: () => ({
          agentDefaultEnv: { claude: {} }
        })
      } as never,
      undefined,
      { prepareCodexStructuredLaunch }
    )
    runtime.setAccountServices({
      claudeAccounts: { getRuntimeConfigDir } as never,
      codexAccounts: {} as never,
      rateLimits: {} as never
    })
    vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
      supported: true
    })
    const internal = runtime as unknown as {
      resolveStructuredAgentSessionLocation: (selector: string) => Promise<{
        executionHostId: string
        wslDistro: null
        workspaceId: string
        workspaceKind: 'git-worktree'
      }>
      resolveRuntimeFileTarget: (selector: string) => Promise<{
        worktree: { path: string }
      }>
    }
    internal.resolveStructuredAgentSessionLocation = vi.fn(async () => ({
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree' as const
    }))
    internal.resolveRuntimeFileTarget = vi.fn(async () => ({
      worktree: { path: '/repos/workspace-1' }
    }))

    const intent = await runtime.resolveStructuredAgentSessionCreateIntent({
      envelope: { sessionId: 'session-1', clientOperationId: 'operation-1' },
      worktree: 'id:workspace-1',
      agent: 'claude'
    })

    expect(getRuntimeConfigDir).toHaveBeenCalledTimes(1)
    expect(intent.accountHome).toEqual({
      variable: 'CLAUDE_CONFIG_DIR',
      path: '/accounts/managed/claude-home'
    })
  })
})

/** The account shape the managed gate refuses; a bound custom home is allowed to bypass it, and a
 *  binding that resolves to the shared home is not. */
const WSL_ONLY_MANAGED_ACCOUNT = {
  claudeManagedAccounts: [
    {
      id: 'wsl-1',
      email: 'wsl-1@example.com',
      managedAuthPath: '/managed/wsl-1',
      managedAuthRuntime: 'wsl',
      authMethod: 'subscription-oauth',
      createdAt: 0,
      updatedAt: 0,
      lastAuthenticatedAt: 0
    }
  ],
  activeClaudeManagedAccountId: null,
  activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'wsl-1' } }
}

describe('project-group Claude home binding', () => {
  const GROUP = {
    id: 'group-1',
    name: 'Bound',
    parentGroupId: null,
    claudeConfigDir: '/bound/claude-home'
  }
  const REPO = { id: 'repo-1', path: '/repos/repo-1', projectGroupId: 'group-1' }

  function boundRuntime(
    overrides: {
      groups?: unknown[]
      repos?: unknown[]
      agentDefaultEnv?: Record<string, Record<string, string>>
      assertBoundHomeUsable?: AssertClaudeBoundHomeUsable
      omitCatalogAccessor?:
        | 'hasHydratedProjectCatalog'
        | 'getProjectGroups'
        | 'getRepos'
        | 'getFolderWorkspaces'
      hydrated?: boolean
      /** Leaves the real create-support probe in place, which is itself under test. */
      realCreateSupport?: boolean
      settings?: Record<string, unknown>
    } = {}
  ) {
    const store: Record<string, unknown> = {
      getSettings: () => ({
        agentDefaultEnv: overrides.agentDefaultEnv ?? { claude: {} },
        ...overrides.settings
      }),
      hasHydratedProjectCatalog: () => overrides.hydrated ?? true,
      getRepos: () => overrides.repos ?? [REPO],
      getFolderWorkspaces: () => [],
      getProjectGroups: () => overrides.groups ?? [GROUP]
    }
    if (overrides.omitCatalogAccessor) {
      delete store[overrides.omitCatalogAccessor]
    }
    const runtime = new OrcaRuntimeService(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the create-intent path reads only these four store accessors.
      store as never,
      undefined,
      {
        prepareCodexStructuredLaunch: vi.fn(),
        ...(overrides.assertBoundHomeUsable
          ? { assertClaudeBoundHomeUsable: overrides.assertBoundHomeUsable }
          : {})
      }
    )
    if (!overrides.realCreateSupport) {
      vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
        supported: true
      })
    }
    // The two protected seams overridden below are the ones this suite already drives.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: protected test seam.
    const internal = runtime as unknown as Record<string, unknown>
    internal.resolveStructuredAgentSessionLocation = vi.fn(async () => ({
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'repo-1::/repos/workspace-1',
      workspaceKind: 'git-worktree' as const
    }))
    internal.resolveRuntimeFileTarget = vi.fn(async () => ({
      worktree: { path: '/repos/workspace-1' }
    }))
    return runtime
  }

  const createInput = {
    envelope: { sessionId: 'session-1', clientOperationId: 'operation-1' },
    worktree: 'id:repo-1::/repos/workspace-1',
    agent: 'claude' as const
  }

  it('pins the bound group home and marks the record with the group', async () => {
    const assertClaudeBoundHomeUsable = vi.fn(async () => {})
    const intent = await boundRuntime({ assertBoundHomeUsable: assertClaudeBoundHomeUsable }) //
      .resolveStructuredAgentSessionCreateIntent(createInput)

    expect(intent.accountHome).toEqual({
      variable: 'CLAUDE_CONFIG_DIR',
      path: '/bound/claude-home',
      binding: { kind: 'project-group', groupId: 'group-1' }
    })
    expect(assertClaudeBoundHomeUsable).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: { configDir: '/bound/claude-home', groupId: 'group-1' },
        location: expect.objectContaining({ executionHostId: 'local', wslDistro: null })
      })
    )
  })

  it('hands the launch env to the usability check so a conflict can refuse', async () => {
    await expect(
      boundRuntime({
        agentDefaultEnv: { claude: { CLAUDE_CONFIG_DIR: '/elsewhere/claude-home' } },
        assertBoundHomeUsable: async ({ launchEnv }) => {
          if (launchEnv.CLAUDE_CONFIG_DIR !== '/bound/claude-home') {
            throw new Error('claude_bound_home_env_conflict')
          }
        }
      }).resolveStructuredAgentSessionCreateIntent(createInput)
    ).rejects.toThrow('claude_bound_home_env_conflict')
  })

  it('takes the unbound path when the workspace group binds nothing', async () => {
    const assertClaudeBoundHomeUsable = vi.fn(async () => {})
    const intent = await boundRuntime({
      groups: [{ ...GROUP, claudeConfigDir: null }],
      agentDefaultEnv: { claude: { CLAUDE_CONFIG_DIR: '/configured/claude-home' } },
      assertBoundHomeUsable: assertClaudeBoundHomeUsable
    }).resolveStructuredAgentSessionCreateIntent(createInput)

    expect(assertClaudeBoundHomeUsable).not.toHaveBeenCalled()
    expect(intent.accountHome).toEqual({
      variable: 'CLAUDE_CONFIG_DIR',
      path: '/configured/claude-home'
    })
  })

  it('leaves a workspace in no group entirely unbound', async () => {
    const intent = await boundRuntime({
      repos: [{ ...REPO, projectGroupId: null }],
      agentDefaultEnv: { claude: { CLAUDE_CONFIG_DIR: '/configured/claude-home' } }
    }).resolveStructuredAgentSessionCreateIntent(createInput)

    expect(intent.accountHome).toEqual({
      variable: 'CLAUDE_CONFIG_DIR',
      path: '/configured/claude-home'
    })
  })

  // A catalog this host cannot read is not evidence of "no binding": answering "unbound" would
  // launch the shared home for a group that bound another one.
  it.each([
    'hasHydratedProjectCatalog',
    'getProjectGroups',
    'getRepos',
    'getFolderWorkspaces'
  ] as const)('refuses by name when the store cannot answer %s', async (accessor) => {
    await expect(
      boundRuntime({ omitCatalogAccessor: accessor }).resolveStructuredAgentSessionCreateIntent(
        createInput
      )
    ).rejects.toThrow('claude_home_binding_catalog_unavailable')
  })

  it('refuses to resume a conversation that does not live under the bound home', async () => {
    await expect(
      boundRuntime({
        assertBoundHomeUsable: async () => {}
      }).resolveStructuredAgentSessionCreateIntent({
        ...createInput,
        resumeFrom: { providerSessionId: 'conversation-in-the-shared-home' }
      })
    ).rejects.toThrow('agent_session_identity_required')
  })

  // An empty catalog from a store that has not loaded its profile state is indistinguishable from
  // "nothing is bound", and answering that launches the shared home for a group that bound another.
  it('refuses by name when the store has not hydrated its project catalog', async () => {
    await expect(
      boundRuntime({ hydrated: false }).resolveStructuredAgentSessionCreateIntent(createInput)
    ).rejects.toThrow('claude_home_binding_catalog_unhydrated')
  })

  // Binding a group to the home the CLI would find on its own pins nothing, so it must not leave
  // the record wearing a marker that switches off the gates protecting that very home.
  it("drops the marker for a binding that names the CLI's own default home", async () => {
    const assertClaudeBoundHomeUsable = vi.fn(async () => {})
    const sharedHome = join(homedir(), '.claude')
    const intent = await boundRuntime({
      groups: [{ ...GROUP, claudeConfigDir: sharedHome }],
      assertBoundHomeUsable: assertClaudeBoundHomeUsable
    }).resolveStructuredAgentSessionCreateIntent(createInput)

    expect(intent.accountHome).toEqual({ variable: 'CLAUDE_CONFIG_DIR', path: sharedHome })
    expect(assertClaudeBoundHomeUsable).not.toHaveBeenCalled()
  })

  // The third reader of the same decision: a no-op binding must not admit a create that the
  // managed-account gate would otherwise refuse.
  it('reports create support unbound for a binding that names the default home', async () => {
    const runtime = boundRuntime({
      groups: [{ ...GROUP, claudeConfigDir: join(homedir(), '.claude') }],
      realCreateSupport: true,
      settings: WSL_ONLY_MANAGED_ACCOUNT
    })

    await expect(
      runtime.getStructuredAgentSessionCreateSupport('id:repo-1::/repos/workspace-1', 'claude')
    ).resolves.toEqual({ supported: false, reason: 'wsl' })
  })

  it('never binds a Codex session', async () => {
    const intent = await boundRuntime({
      agentDefaultEnv: { codex: { CODEX_HOME: '/configured/codex-home' } }
    }).resolveStructuredAgentSessionCreateIntent({ ...createInput, agent: 'codex' })

    expect(intent.accountHome.variable).toBe('CODEX_HOME')
    expect(intent.accountHome).not.toHaveProperty('binding')
  })
})
