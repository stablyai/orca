import { describe, expect, it } from 'vitest'
import { terminalShellOverrideRefusal } from './terminal-shell-override-host-support'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'

const NO_PROJECT_RUNTIME = undefined
const WINDOWS_WORKSPACE = 'C:\\Users\\u\\app'
const WSL_WORKSPACE = '\\\\wsl$\\Ubuntu\\home\\u\\app'
const ON_WINDOWS_HOST = { cwd: WINDOWS_WORKSPACE, workspacePath: WINDOWS_WORKSPACE }

function resolvedRuntime(kind: 'windows-host' | 'wsl'): ProjectExecutionRuntimeResolution {
  return kind === 'wsl'
    ? {
        status: 'resolved',
        runtime: {
          kind: 'wsl',
          hostPlatform: 'wsl',
          distro: 'Ubuntu',
          projectId: 'p1',
          reason: 'project-override',
          cacheKey: 'p1:wsl:Ubuntu'
        }
      }
    : {
        status: 'resolved',
        runtime: {
          kind: 'windows-host',
          hostPlatform: 'win32',
          projectId: 'p1',
          reason: 'project-override',
          cacheKey: 'p1:windows-host'
        }
      }
}

describe('terminalShellOverrideRefusal', () => {
  it('allows a requested shell on a local Windows execution host', () => {
    expect(
      terminalShellOverrideRefusal({
        shellOverride: 'cmd.exe',
        connectionId: null,
        platform: 'win32',
        projectRuntime: NO_PROJECT_RUNTIME,
        ...ON_WINDOWS_HOST
      })
    ).toBeNull()
  })

  it('stays out of the way when no shell was requested', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(
        terminalShellOverrideRefusal({
          shellOverride: undefined,
          connectionId: 'ssh-1',
          platform,
          projectRuntime: resolvedRuntime('wsl'),
          ...ON_WINDOWS_HOST
        })
      ).toBeNull()
    }
  })

  // Both of these hosts would otherwise spawn their default shell and report success.
  it('refuses when the spawn happens over SSH', () => {
    expect(
      terminalShellOverrideRefusal({
        shellOverride: 'cmd.exe',
        connectionId: 'ssh-1',
        platform: 'win32',
        projectRuntime: NO_PROJECT_RUNTIME,
        ...ON_WINDOWS_HOST
      })?.message
    ).toContain('over SSH')
  })

  it('refuses on a host that has no Windows shells to pick from', () => {
    expect(
      terminalShellOverrideRefusal({
        shellOverride: 'cmd.exe',
        connectionId: null,
        platform: 'darwin',
        projectRuntime: NO_PROJECT_RUNTIME,
        ...ON_WINDOWS_HOST
      })?.message
    ).toContain('darwin')
  })

  // `resolveLocalWindowsTerminalRuntimeOptions` rewrites a shell that contradicts the project's
  // execution runtime, which would hand back a terminal running something else entirely — and
  // would quote an agent's startup command for the shell that was asked for, not the one running.
  it('refuses a WSL shell when the project runs its terminals on the Windows host', () => {
    expect(
      terminalShellOverrideRefusal({
        shellOverride: 'wsl.exe',
        connectionId: null,
        platform: 'win32',
        projectRuntime: resolvedRuntime('windows-host'),
        ...ON_WINDOWS_HOST
      })?.message
    ).toContain('on the Windows host')
  })

  it('refuses a Windows shell when the project runs its terminals in WSL', () => {
    expect(
      terminalShellOverrideRefusal({
        shellOverride: 'cmd.exe',
        connectionId: null,
        platform: 'win32',
        projectRuntime: resolvedRuntime('wsl'),
        ...ON_WINDOWS_HOST
      })?.message
    ).toContain('in WSL')
  })

  it('allows a shell that agrees with the project runtime', () => {
    expect(
      terminalShellOverrideRefusal({
        shellOverride: 'wsl.exe',
        connectionId: null,
        platform: 'win32',
        projectRuntime: resolvedRuntime('wsl'),
        ...ON_WINDOWS_HOST
      })
    ).toBeNull()
    expect(
      terminalShellOverrideRefusal({
        shellOverride: 'powershell.exe',
        connectionId: null,
        platform: 'win32',
        projectRuntime: resolvedRuntime('windows-host'),
        ...ON_WINDOWS_HOST
      })
    ).toBeNull()
  })

  // `resolveWslSessionContext` forces wsl.exe for any `\\wsl$` cwd or workspace path, which is
  // the one rewrite the project-runtime check cannot see: a folder workspace has no project.
  describe('WSL UNC paths', () => {
    it('refuses a Windows shell for a folder workspace inside a WSL distro with no project runtime', () => {
      const message = terminalShellOverrideRefusal({
        shellOverride: 'cmd.exe',
        connectionId: null,
        platform: 'win32',
        projectRuntime: NO_PROJECT_RUNTIME,
        cwd: WSL_WORKSPACE,
        workspacePath: WSL_WORKSPACE
      })?.message
      expect(message).toContain('inside WSL')
      expect(message).toContain('No terminal was created')
      expect(message).toContain('--shell wsl.exe')
    })

    it('refuses when only the workspace root is in WSL, since the session path forces wsl.exe too', () => {
      expect(
        terminalShellOverrideRefusal({
          shellOverride: 'powershell.exe',
          connectionId: null,
          platform: 'win32',
          projectRuntime: NO_PROJECT_RUNTIME,
          cwd: WINDOWS_WORKSPACE,
          workspacePath: WSL_WORKSPACE
        })?.message
      ).toContain(WSL_WORKSPACE)
    })

    it('accepts the forward-slash wsl.localhost spelling as a WSL path', () => {
      expect(
        terminalShellOverrideRefusal({
          shellOverride: 'cmd.exe',
          connectionId: null,
          platform: 'win32',
          projectRuntime: NO_PROJECT_RUNTIME,
          cwd: '//wsl.localhost/Ubuntu/home/u/app/src',
          workspacePath: '//wsl.localhost/Ubuntu/home/u/app'
        })
      ).not.toBeNull()
    })

    it('allows wsl.exe for a WSL path', () => {
      expect(
        terminalShellOverrideRefusal({
          shellOverride: 'wsl.exe',
          connectionId: null,
          platform: 'win32',
          projectRuntime: NO_PROJECT_RUNTIME,
          cwd: WSL_WORKSPACE,
          workspacePath: WSL_WORKSPACE
        })
      ).toBeNull()
    })

    it('still allows a Windows shell for a plain Windows path', () => {
      expect(
        terminalShellOverrideRefusal({
          shellOverride: 'cmd.exe',
          connectionId: null,
          platform: 'win32',
          projectRuntime: NO_PROJECT_RUNTIME,
          cwd: 'C:\\Users\\u\\app\\src',
          workspacePath: WINDOWS_WORKSPACE
        })
      ).toBeNull()
    })
  })
})
