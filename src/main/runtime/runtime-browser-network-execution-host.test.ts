import { describe, expect, it } from 'vitest'
import type { SshProviderEpoch } from '../../shared/ssh-types'
import { resolveRuntimeBrowserNetworkExecutionHost } from './runtime-browser-network-execution-host'

describe('runtime browser network execution host', () => {
  it('binds native routes to the exact runtime incarnation', () => {
    expect(
      resolveRuntimeBrowserNetworkExecutionHost({
        runtimeId: 'runtime-a',
        runtimeRevision: 7,
        executionHostId: 'local'
      })
    ).toEqual({ kind: 'native', runtimeId: 'runtime-a', revision: 7 })
  })

  it('binds SSH routes to the current connected provider authority', () => {
    expect(
      resolveRuntimeBrowserNetworkExecutionHost({
        runtimeId: 'runtime-a',
        runtimeRevision: 7,
        executionHostId: 'ssh:target-a',
        sshState: {
          targetId: 'target-a',
          status: 'connected',
          error: null,
          reconnectAttempt: 0,
          providerEpoch: 'provider-a' as SshProviderEpoch,
          connectionGeneration: 4
        }
      })
    ).toEqual({
      kind: 'ssh',
      targetId: 'target-a',
      providerEpoch: 'provider-a',
      connectionGeneration: 4
    })
  })

  it('rejects disconnected or incomplete SSH authority instead of routing natively', () => {
    expect(() =>
      resolveRuntimeBrowserNetworkExecutionHost({
        runtimeId: 'runtime-a',
        runtimeRevision: 7,
        executionHostId: 'ssh:target-a',
        sshState: {
          targetId: 'target-a',
          status: 'disconnected',
          error: null,
          reconnectAttempt: 0
        }
      })
    ).toThrow('browser_tunnel_execution_host_unavailable')
  })

  it('binds WSL routes to the exact runtime incarnation and distro', () => {
    expect(
      resolveRuntimeBrowserNetworkExecutionHost({
        runtimeId: 'runtime-a',
        runtimeRevision: 7,
        executionHostId: 'local',
        projectRuntime: {
          status: 'resolved',
          runtime: {
            kind: 'wsl',
            hostPlatform: 'wsl',
            projectId: 'project-a',
            distro: 'Ubuntu',
            reason: 'project-override',
            cacheKey: 'wsl:Ubuntu'
          }
        }
      })
    ).toEqual({ kind: 'wsl', runtimeId: 'runtime-a', revision: 7, distro: 'Ubuntu' })
  })

  it('rejects a nested runtime execution owner instead of silently using this runtime', () => {
    expect(() =>
      resolveRuntimeBrowserNetworkExecutionHost({
        runtimeId: 'runtime-a',
        runtimeRevision: 7,
        executionHostId: 'runtime:environment-b'
      })
    ).toThrow('browser_tunnel_execution_host_unavailable')
  })
})
