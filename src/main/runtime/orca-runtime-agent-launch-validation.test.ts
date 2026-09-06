import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

const {
  detectInstalledAgents,
  detectRemoteAgents,
  detectWslCommandsOnPath,
  detectLocalManagedAgentCliPresence,
  resolveLocalProjectRuntimeForRepo,
  isCommandOnLocalPath
} = vi.hoisted(() => ({
  detectInstalledAgents: vi.fn<(...args: never[]) => Promise<string[]>>(),
  detectRemoteAgents: vi.fn<(...args: never[]) => Promise<string[]>>(),
  detectWslCommandsOnPath: vi.fn<(...args: never[]) => Promise<Set<string>>>(),
  detectLocalManagedAgentCliPresence:
    vi.fn<(...args: never[]) => Promise<Record<string, unknown>>>(),
  resolveLocalProjectRuntimeForRepo: vi.fn(),
  isCommandOnLocalPath: vi.fn()
}))

vi.mock('../preflight/agent-detection', () => ({
  detectInstalledAgentsWithShellPathHydration: detectInstalledAgents,
  detectRemoteAgents
}))
vi.mock('../ipc/preflight-wsl-agent-detection', () => ({ detectWslCommandsOnPath }))
vi.mock('../agent-hooks/local-agent-cli-presence', () => ({ detectLocalManagedAgentCliPresence }))
vi.mock('../project-runtime-git-options', () => ({ resolveLocalProjectRuntimeForRepo }))
vi.mock('../ipc/command-path-resolver', () => ({ isCommandOnLocalPath }))
vi.mock('../../shared/managed-agent-hook-targets', () => ({
  getManagedAgentHookTarget: () => null
}))

const repo = (connectionId?: string) => ({
  id: 'repo-1',
  path: '/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0,
  ...(connectionId ? { connectionId } : {})
})

function createRuntime(settings: Record<string, unknown> = {}) {
  const runtime = new OrcaRuntimeService()
  ;(runtime as unknown as { store: unknown }).store = {
    getSettings: () => ({ agentCmdOverrides: {}, ...settings })
  }
  vi.spyOn(runtime, 'showRepo').mockResolvedValue(repo() as never)
  return runtime
}

afterEach(() => {
  vi.clearAllMocks()
  resolveLocalProjectRuntimeForRepo.mockReturnValue(undefined)
  detectInstalledAgents.mockResolvedValue([])
  detectRemoteAgents.mockResolvedValue([])
  detectWslCommandsOnPath.mockResolvedValue(new Set())
  detectLocalManagedAgentCliPresence.mockResolvedValue({})
  isCommandOnLocalPath.mockResolvedValue(false)
})

describe('validateOrchestrationAgentLauncherForRepo', () => {
  it('uses strict remote detection and keeps remote unavailable errors', async () => {
    const runtime = createRuntime()
    vi.spyOn(runtime, 'showRepo').mockResolvedValue(repo('ssh-1') as never)
    detectRemoteAgents.mockResolvedValue(['codex'])

    await expect(
      runtime.validateOrchestrationAgentLauncherForRepo('codex', 'repo-1')
    ).resolves.toBeUndefined()
    expect(detectRemoteAgents).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'ssh-1', requireAvailable: true })
    )
  })

  it('includes a custom remote override in the probe request', async () => {
    const runtime = createRuntime({ agentCmdOverrides: { codex: 'managed-codex --flag' } })
    vi.spyOn(runtime, 'showRepo').mockResolvedValue(repo('ssh-1') as never)
    detectRemoteAgents.mockResolvedValue(['codex'])

    await runtime.validateOrchestrationAgentLauncherForRepo('codex', 'repo-1')
    expect(detectRemoteAgents.mock.calls[0]?.[0]).toMatchObject({
      commands: expect.arrayContaining([
        expect.objectContaining({ id: 'codex', cmd: 'managed-codex' })
      ])
    })
  })

  it.each([
    ['native', undefined, ['codex']],
    ['wsl', { status: 'resolved', runtime: { kind: 'wsl', distro: 'Ubuntu' } }, ['codex']]
  ])('accepts detected %s local agents', async (_name, projectRuntime, detected) => {
    const runtime = createRuntime()
    resolveLocalProjectRuntimeForRepo.mockReturnValue(projectRuntime)
    detectInstalledAgents.mockResolvedValue(detected)

    await expect(
      runtime.validateOrchestrationAgentLauncherForRepo('codex', 'repo-1')
    ).resolves.toBeUndefined()
  })

  it('accepts a native bare override with the inherited PATH', async () => {
    const runtime = createRuntime({ agentCmdOverrides: { amp: 'managed-amp' } })
    detectInstalledAgents.mockResolvedValue([])
    isCommandOnLocalPath.mockResolvedValue(true)

    await runtime.validateOrchestrationAgentLauncherForRepo('amp', 'repo-1')
    expect(isCommandOnLocalPath).toHaveBeenCalledWith(
      'managed-amp',
      expect.objectContaining({ env: expect.objectContaining({ PATH: expect.any(String) }) })
    )
  })

  it('probes a WSL override strictly and accepts it when found', async () => {
    const runtime = createRuntime({ agentCmdOverrides: { codex: '~/bin/codex' } })
    resolveLocalProjectRuntimeForRepo.mockReturnValue({
      status: 'resolved',
      runtime: { kind: 'wsl', distro: 'Ubuntu' }
    })
    detectInstalledAgents.mockResolvedValue([])
    detectWslCommandsOnPath.mockResolvedValue(new Set(['~/bin/codex']))

    await runtime.validateOrchestrationAgentLauncherForRepo('codex', 'repo-1')
    expect(detectWslCommandsOnPath).toHaveBeenCalledWith({ distro: 'Ubuntu' }, ['~/bin/codex'], {
      failOnProbeError: true
    })
  })

  it('reports a missing agent from a repair-required runtime without probing its override', async () => {
    const runtime = createRuntime({ agentCmdOverrides: { amp: 'managed-amp' } })
    resolveLocalProjectRuntimeForRepo.mockReturnValue({
      status: 'repair-required',
      repair: {
        projectId: 'repo-1',
        preferredRuntime: { kind: 'wsl', distro: 'Ubuntu' },
        reason: 'wsl-unavailable',
        source: 'project-override',
        cacheKey: 'repo-1'
      }
    })
    detectInstalledAgents.mockResolvedValue([])

    await expect(
      runtime.validateOrchestrationAgentLauncherForRepo('amp', 'repo-1')
    ).rejects.toMatchObject({ code: 'agent_not_available' })
    expect(isCommandOnLocalPath).not.toHaveBeenCalled()
  })

  it('validates claude-teams through Claude on Windows', async () => {
    const runtime = createRuntime()
    vi.spyOn(runtime, 'showRepo').mockResolvedValue(repo() as never)
    vi.spyOn(
      runtime as unknown as { getAgentLaunchPlatformForRepo: (repo: unknown) => NodeJS.Platform },
      'getAgentLaunchPlatformForRepo'
    ).mockReturnValue('win32')
    detectInstalledAgents.mockResolvedValue(['claude'])

    await expect(
      runtime.validateOrchestrationAgentLauncherForRepo('claude-agent-teams', 'repo-1')
    ).resolves.toBeUndefined()
  })
})
