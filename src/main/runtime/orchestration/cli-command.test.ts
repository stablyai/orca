import { describe, expect, it } from 'vitest'
import { resolveTerminalOrchestrationCliCommand } from './cli-command'

describe('resolveTerminalOrchestrationCliCommand', () => {
  it('uses orca-ide for a pane recorded as WSL', () => {
    expect(
      resolveTerminalOrchestrationCliCommand({
        connectionId: null,
        isWsl: true,
        worktreeId: 'repo::C:\\repo'
      })
    ).toBe('orca-ide')
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
    ).toBe('orca-ide')
    expect(
      resolveTerminalOrchestrationCliCommand({
        connectionId: null,
        isWsl: null,
        worktreeId: 'repo::\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo'
      })
    ).toBe('orca-ide')
  })

  it('preserves native bare-orca and isolates SSH orchestration from host collisions', () => {
    expect(
      resolveTerminalOrchestrationCliCommand({
        connectionId: null,
        isWsl: false,
        worktreeId: 'repo::/home/alice/repo'
      })
    ).toBe('orca')
    expect(
      resolveTerminalOrchestrationCliCommand({
        connectionId: 'ssh-1',
        isWsl: null,
        worktreeId: 'repo::\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo',
        sshCliCommand: {
          kind: 'posix-path',
          executablePath: '/home/alice/.orca-relay/bin/orca-relay'
        }
      })
    ).toEqual({
      kind: 'posix-path',
      executablePath: '/home/alice/.orca-relay/bin/orca-relay'
    })
  })

  it('fails before dispatch when an SSH launcher was not proven', () => {
    expect(() =>
      resolveTerminalOrchestrationCliCommand({
        connectionId: 'ssh-1',
        isWsl: false,
        worktreeId: 'repo::/home/alice/repo',
        sshCliCommand: null
      })
    ).toThrow(/remote CLI launcher was not installed/)
  })
})
