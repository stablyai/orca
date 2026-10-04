import type { AgentStartupShell } from '../../shared/tui-agent-startup-shell'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { resolveConfiguredWorkerAgent } from './orchestration/configured-worker-agent-selector'

it.each(['folder', 'ssh', 'wsl'] as const)(
  'resolves the %s target platform before interpreting an alias',
  async (kind) => {
    const scope = {
      path: kind === 'wsl' ? '\\\\wsl.localhost\\Ubuntu\\repo' : '/opt/repo',
      connectionId: kind === 'ssh' ? 'ssh-1' : null
    }
    const context = {
      resolveTerminalWorkspaceLaunchScope: vi.fn(async () => scope),
      getAgentLaunchPlatformForWorkspace: vi.fn(() => 'linux' as const),
      resolveOrchestrationAgentLauncher: vi.fn(
        (selector: string, platform: NodeJS.Platform, shell?: AgentStartupShell) =>
          resolveConfiguredWorkerAgent(
            selector,
            { opencode: '/opt/My\\ Agent/opencode-private' },
            platform,
            shell
          )
      )
    }
    const result =
      await OrcaRuntimeService.prototype.resolveOrchestrationAgentLauncherForTarget.call(
        context,
        'opencode-private',
        { worktree: 'id:workspace' }
      )
    expect(result).toBe('opencode')
    expect(context.getAgentLaunchPlatformForWorkspace).toHaveBeenCalledWith(scope)
    expect(context.resolveOrchestrationAgentLauncher).toHaveBeenCalledWith(
      'opencode-private',
      'linux',
      'posix'
    )
  }
)

describe('canonical worker agent target', () => {
  it('keeps canonical selectors authoritative without probing another host', async () => {
    const resolve = vi.fn()
    expect(
      await OrcaRuntimeService.prototype.resolveOrchestrationAgentLauncherForTarget.call(
        { resolveTerminalWorkspaceLaunchScope: resolve },
        'opencode',
        { worktree: 'id:remote' }
      )
    ).toBe('opencode')
    expect(resolve).not.toHaveBeenCalled()
  })
})

it('resolves local Windows shell settings rather than assuming PowerShell', async () => {
  const context = {
    store: { getSettings: () => ({ terminalWindowsShell: 'bash.exe' }) },
    resolveTerminalWorkspaceLaunchScope: vi.fn(async () => ({
      path: 'C:\\repo',
      connectionId: null
    })),
    getAgentLaunchPlatformForWorkspace: vi.fn(() => 'win32' as const),
    resolveOrchestrationAgentLauncher: vi.fn(
      (selector: string, platform: NodeJS.Platform, shell?: AgentStartupShell) =>
        resolveConfiguredWorkerAgent(
          selector,
          { opencode: '/c/Agent\\ Directory/opencode-private.exe' },
          platform,
          shell
        )
    )
  }
  expect(
    await OrcaRuntimeService.prototype.resolveOrchestrationAgentLauncherForTarget.call(
      context,
      'opencode-private',
      { worktree: 'id:workspace' }
    )
  ).toBe('opencode')
  expect(context.resolveOrchestrationAgentLauncher).toHaveBeenCalledWith(
    'opencode-private',
    'win32',
    'posix'
  )
})
