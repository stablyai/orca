import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type * as LocalAgentCliPresence from '../agent-hooks/local-agent-cli-presence'
import { resolveStructuredAgentCommand } from '../native-chat/structured-agent-command-resolution'

const {
  detectInstalledAgents,
  detectWslCommandsOnPath,
  detectLocalManagedAgentCliPresence,
  resolveLocalProjectRuntimeForRepo,
  isCommandOnLocalPath,
  agentLaunchPlatformForScope
} = vi.hoisted(() => ({
  detectInstalledAgents: vi.fn<(...args: never[]) => Promise<string[]>>(),
  detectWslCommandsOnPath: vi.fn<(...args: never[]) => Promise<Set<string>>>(),
  detectLocalManagedAgentCliPresence:
    vi.fn<typeof LocalAgentCliPresence.detectLocalManagedAgentCliPresence>(),
  resolveLocalProjectRuntimeForRepo: vi.fn(),
  isCommandOnLocalPath: vi.fn(),
  agentLaunchPlatformForScope: vi.fn(() => process.platform)
}))

vi.mock('../preflight/agent-detection', () => ({
  detectInstalledAgentsWithShellPathHydration: detectInstalledAgents
}))
vi.mock('../ipc/preflight-wsl-agent-detection', () => ({ detectWslCommandsOnPath }))
vi.mock('../agent-hooks/local-agent-cli-presence', () => ({ detectLocalManagedAgentCliPresence }))
vi.mock('../project-runtime-git-options', () => ({ resolveLocalProjectRuntimeForRepo }))
vi.mock('../ipc/command-path-resolver', () => ({ isCommandOnLocalPath }))
vi.mock('./agent-launch-scope-runtime', () => ({ agentLaunchPlatformForScope }))

const actualLocalAgentCliPresence = await vi.importActual<typeof LocalAgentCliPresence>(
  '../agent-hooks/local-agent-cli-presence'
)

const repo = (connectionId?: string) => ({
  id: 'repo-1',
  path: '/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0,
  ...(connectionId ? { connectionId } : {})
})

const temporaryRoots: string[] = []

function createRuntime(settings: Record<string, unknown> = {}) {
  const runtime = new OrcaRuntimeService()
  Object.assign(runtime, { store: { getSettings: () => ({ agentCmdOverrides: {}, ...settings }) } })
  vi.spyOn(runtime, 'showRepo').mockResolvedValue(repo())
  return runtime
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
  vi.clearAllMocks()
  resolveLocalProjectRuntimeForRepo.mockReturnValue(undefined)
  detectInstalledAgents.mockResolvedValue([])
  detectWslCommandsOnPath.mockResolvedValue(new Set())
  detectLocalManagedAgentCliPresence.mockResolvedValue({})
  isCommandOnLocalPath.mockResolvedValue(false)
  agentLaunchPlatformForScope.mockReturnValue(process.platform)
})

describe('validateOrchestrationAgentLauncherForRepo', () => {
  it.each([undefined, 'managed-codex --flag'])(
    'rejects an unserved SSH target without probing the local host (override: %s)',
    async (override) => {
      const runtime = createRuntime({ agentCmdOverrides: { codex: override } })
      vi.spyOn(runtime, 'showRepo').mockResolvedValue(repo('ssh-1'))

      await expect(
        runtime.validateOrchestrationAgentLauncherForRepo('codex', 'repo-1')
      ).rejects.toMatchObject({ code: 'ssh_host_not_served', connectionId: 'ssh-1' })
      expect(detectInstalledAgents).not.toHaveBeenCalled()
      expect(detectWslCommandsOnPath).not.toHaveBeenCalled()
      expect(isCommandOnLocalPath).not.toHaveBeenCalled()
    }
  )

  it('rejects an executionHostId-only SSH target without probing this client', async () => {
    const runtime = createRuntime()
    vi.spyOn(runtime, 'showRepo').mockResolvedValue({ ...repo(), executionHostId: 'ssh:remote' })

    await expect(
      runtime.validateOrchestrationAgentLauncherForRepo('codex', 'repo-1')
    ).rejects.toMatchObject({ code: 'ssh_host_not_served', connectionId: 'remote' })
    expect(detectInstalledAgents).not.toHaveBeenCalled()
    expect(resolveLocalProjectRuntimeForRepo).not.toHaveBeenCalled()
  })

  it('ignores a stale SSH connection beside explicit local ownership', async () => {
    const runtime = createRuntime()
    vi.spyOn(runtime, 'showRepo').mockResolvedValue({
      ...repo('stale-remote'),
      executionHostId: 'local'
    })
    detectInstalledAgents.mockResolvedValue(['codex'])

    await expect(
      runtime.validateOrchestrationAgentLauncherForRepo('codex', 'repo-1')
    ).resolves.toBeUndefined()
    expect(resolveLocalProjectRuntimeForRepo).toHaveBeenCalled()
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

  it.each(['amp', 'aider'] as const)(
    'accepts a native %s override with inherited PATH',
    async (agent) => {
      const runtime = createRuntime({ agentCmdOverrides: { [agent]: 'managed-agent' } })
      detectInstalledAgents.mockResolvedValue([])
      isCommandOnLocalPath.mockResolvedValue(true)
      detectLocalManagedAgentCliPresence.mockResolvedValue({
        amp: { state: 'found', executablePath: '/managed/managed-agent' }
      })

      await runtime.validateOrchestrationAgentLauncherForRepo(agent, 'repo-1')
      if (agent === 'amp') {
        expect(detectLocalManagedAgentCliPresence).toHaveBeenCalledWith(
          expect.any(Array),
          expect.any(Object),
          { pathEnv: expect.any(String) }
        )
      } else {
        expect(isCommandOnLocalPath).toHaveBeenCalledWith(
          'managed-agent',
          expect.objectContaining({ env: expect.objectContaining({ PATH: expect.any(String) }) })
        )
      }
    }
  )

  it.each([false, true])(
    'validates the configured native executable despite an installed default (override found: %s)',
    async (overrideFound) => {
      const root = mkdtempSync(join(tmpdir(), 'orca-worker-override-'))
      temporaryRoots.push(root)
      const executable = join(root, process.platform === 'win32' ? 'codex.cmd' : 'codex')
      writeFileSync(executable, '#!/bin/sh\nexit 0\n')
      chmodSync(executable, 0o755)
      const runtime = createRuntime({
        agentCmdOverrides: { codex: `${overrideFound ? 'codex' : 'missing-codex'} --profile work` },
        agentDefaultEnv: { codex: { PATH: root } }
      })
      detectInstalledAgents.mockResolvedValue(['codex'])
      detectLocalManagedAgentCliPresence.mockImplementation(
        actualLocalAgentCliPresence.detectLocalManagedAgentCliPresence
      )

      const validation = runtime.validateOrchestrationAgentLauncherForRepo('codex', 'repo-1')
      await (overrideFound
        ? expect(validation).resolves.toBeUndefined()
        : expect(validation).rejects.toMatchObject({ code: 'agent_not_available' }))
    }
  )

  it.each(['wrapper --flag', 'npx codex', '"unfinished'])(
    'rejects the same invalid structured Command as the launcher: %s',
    async (command) => {
      const settings = { agentCmdOverrides: { codex: command } }
      const runtime = createRuntime(settings)
      detectInstalledAgents.mockResolvedValue(['codex'])
      detectLocalManagedAgentCliPresence.mockResolvedValue({
        codex: { state: 'found', executablePath: '/managed/wrapper' }
      })
      expect(() => resolveStructuredAgentCommand('codex', settings)).toThrow(
        expect.objectContaining({ reason: 'agentCommandNotRunnable' })
      )
      await expect(
        runtime.validateOrchestrationAgentLauncherForRepo('codex', 'repo-1', 'structured')
      ).rejects.toMatchObject({ code: 'agent_not_available' })
    }
  )

  it.each([false, true])(
    'matches structured launch resolution for quoted paths (executable exists: %s)',
    async (exists) => {
      const root = mkdtempSync(join(tmpdir(), 'orca-worker-structured-command-'))
      temporaryRoots.push(root)
      const executable = join(root, process.platform === 'win32' ? 'my agent.cmd' : 'my agent')
      if (exists) {
        writeFileSync(executable, '#!/bin/sh\nexit 0\n')
        chmodSync(executable, 0o755)
      }
      const settings = { agentCmdOverrides: { codex: `"${executable}"` } }
      const runtime = createRuntime(settings)
      detectInstalledAgents.mockResolvedValue(['codex'])
      const validation = runtime.validateOrchestrationAgentLauncherForRepo(
        'codex',
        'repo-1',
        'structured'
      )
      await (exists
        ? expect(validation).resolves.toBeUndefined()
        : expect(validation).rejects.toMatchObject({ code: 'agent_not_available' }))
      if (exists) {
        expect(resolveStructuredAgentCommand('codex', settings)).toBe(executable)
      }
    }
  )

  it.each([false, true])(
    'validates the configured WSL executable despite an installed default (override found: %s)',
    async (overrideFound) => {
      const runtime = createRuntime({ agentCmdOverrides: { codex: '~/bin/custom-codex' } })
      resolveLocalProjectRuntimeForRepo.mockReturnValue({
        status: 'resolved',
        runtime: { kind: 'wsl', distro: 'Ubuntu' }
      })
      detectInstalledAgents.mockResolvedValue(['codex'])
      detectWslCommandsOnPath.mockResolvedValue(
        new Set(overrideFound ? ['~/bin/custom-codex'] : [])
      )

      const validation = runtime.validateOrchestrationAgentLauncherForRepo('codex', 'repo-1')
      await (overrideFound
        ? expect(validation).resolves.toBeUndefined()
        : expect(validation).rejects.toMatchObject({ code: 'agent_not_available' }))
      expect(detectWslCommandsOnPath).toHaveBeenCalledWith(
        { distro: 'Ubuntu' },
        ['~/bin/custom-codex'],
        { failOnProbeError: true }
      )
    }
  )

  it('does not hide an unavailable WSL override probe behind an installed default', async () => {
    const runtime = createRuntime({ agentCmdOverrides: { codex: '~/bin/custom-codex' } })
    resolveLocalProjectRuntimeForRepo.mockReturnValue({
      status: 'resolved',
      runtime: { kind: 'wsl', distro: 'Ubuntu' }
    })
    detectInstalledAgents.mockResolvedValue(['codex'])
    const error = Object.assign(new Error('WSL unavailable'), {
      code: 'remote_runtime_unavailable'
    })
    detectWslCommandsOnPath.mockRejectedValueOnce(error)

    await expect(runtime.validateOrchestrationAgentLauncherForRepo('codex', 'repo-1')).rejects.toBe(
      error
    )
  })

  it('does not use the Claude Teams fallback for a missing configured executable', async () => {
    const runtime = createRuntime({
      agentCmdOverrides: { 'claude-agent-teams': 'missing-claude --teams' }
    })
    agentLaunchPlatformForScope.mockReturnValue('win32')
    detectInstalledAgents.mockResolvedValue(['claude'])
    isCommandOnLocalPath.mockResolvedValue(false)

    await expect(
      runtime.validateOrchestrationAgentLauncherForRepo('claude-agent-teams', 'repo-1')
    ).rejects.toMatchObject({ code: 'agent_not_available' })
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

  it('preserves an unavailable WSL host instead of reporting a missing agent', async () => {
    const runtime = createRuntime()
    const error = Object.assign(new Error('WSL unavailable'), {
      code: 'remote_runtime_unavailable'
    })
    detectInstalledAgents.mockRejectedValueOnce(error)

    await expect(runtime.validateOrchestrationAgentLauncherForRepo('codex', 'repo-1')).rejects.toBe(
      error
    )
    expect(detectInstalledAgents).toHaveBeenCalledWith(
      { projectRuntime: undefined },
      { failOnProbeError: true }
    )
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
    agentLaunchPlatformForScope.mockReturnValue('win32')
    detectInstalledAgents.mockResolvedValue(['claude'])

    await expect(
      runtime.validateOrchestrationAgentLauncherForRepo('claude-agent-teams', 'repo-1')
    ).resolves.toBeUndefined()
  })
})
