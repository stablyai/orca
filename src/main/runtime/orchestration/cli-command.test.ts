import { describe, expect, it } from 'vitest'
import { resolveTerminalOrchestrationCliCommand } from './cli-command'

describe('resolveTerminalOrchestrationCliCommand', () => {
  it('uses mcode-ide for a pane recorded as WSL', () => {
    expect(
      resolveTerminalOrchestrationCliCommand({
        connectionId: null,
        isWsl: true,
        worktreeId: 'repo::C:\\repo'
      })
    ).toBe('mcode-ide')
  })

  it('uses project runtime and WSL paths when restored pane metadata is unavailable', () => {
    expect(
      resolveTerminalOrchestrationCliCommand({
        connectionId: null,
        isWsl: null,
        worktreeId: 'repo::C:\\repo',
        projectRuntime: {
          status: 'resolved',
          runtime: {
            kind: 'wsl',
            hostPlatform: 'wsl',
            projectId: 'project',
            distro: 'Ubuntu',
            reason: 'project-override',
            cacheKey: 'project:wsl:Ubuntu'
          }
        }
      })
    ).toBe('mcode-ide')
    expect(
      resolveTerminalOrchestrationCliCommand({
        connectionId: null,
        isWsl: null,
        worktreeId: 'repo::\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo'
      })
    ).toBe('mcode-ide')
  })

  it('preserves native and SSH bare-mcode commands', () => {
    expect(
      resolveTerminalOrchestrationCliCommand({
        connectionId: null,
        isWsl: false,
        worktreeId: 'repo::/home/alice/repo'
      })
    ).toBe('mcode')
    expect(
      resolveTerminalOrchestrationCliCommand({
        connectionId: 'ssh-1',
        isWsl: null,
        worktreeId: 'repo::\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo'
      })
    ).toBe('mcode')
  })
})
