import { describe, expect, it } from 'vitest'

import { resolveRuntimeBrowserNetworkExecutionHost } from './runtime-browser-network-execution-host'

describe('runtime browser network execution host', () => {
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
