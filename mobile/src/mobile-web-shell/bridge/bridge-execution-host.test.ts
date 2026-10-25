import { onTestFinished, describe, expect, it, vi } from 'vitest'
import { scopeRpcClientToExecutionHost } from '../../transport/execution-host-scoped-rpc-client'
import type { RpcClient } from '../../transport/rpc-client'
import type { RpcResponse } from '../../transport/types'
import { createBridgePortPair } from './bridge-port-pair-test-harness'
import { createPageClient, INIT } from './bridge-page-client-test-harness'

const SERVER = 'runtime:env-1' as const

function recordingShellClient() {
  const sendRequest = vi.fn((..._args: unknown[]) => new Promise<RpcResponse>(() => {}))
  const subscribe = vi.fn(
    (..._args: unknown[]) =>
      () =>
        undefined
  )
  const client: RpcClient = {
    sendRequest,
    subscribe,
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => 0,
    onStateChange: () => () => undefined,
    notifyForeground: () => {},
    close: () => {}
  }
  return { client, sendRequest, subscribe }
}

describe('a server workspace call across the shell bridge', () => {
  it('reaches the shell client with its executionHost on the envelope', async () => {
    const shell = recordingShellClient()
    const pair = createBridgePortPair({ rpc: shell.client })
    onTestFinished(() => {
      pair.client.close()
      pair.host.dispose()
    })
    await pair.flush()

    const server = scopeRpcClientToExecutionHost(pair.client, SERVER)
    void server.sendRequest('worktree.ps', { limit: 1 }).catch(() => undefined)
    server.subscribe('terminal.subscribe', { terminal: 't1' }, () => {})
    await pair.flush()

    expect(shell.sendRequest.mock.calls).toEqual([
      ['worktree.ps', { limit: 1 }, { envelope: { executionHost: SERVER } }]
    ])
    expect(shell.subscribe.mock.calls).toEqual([
      [
        'terminal.subscribe',
        { terminal: 't1' },
        expect.any(Function),
        { envelope: { executionHost: SERVER } }
      ]
    ])
    pair.client.close()
    pair.host.dispose()
  })

  it('refuses it under a shell without the envelope, instead of running it on the desktop', async () => {
    const page = createPageClient()
    onTestFinished(() => page.client.close())
    page.deliver({ ...INIT, grants: { ...INIT.grants, native: [] } })
    expect(page.client.carriesRpcEnvelope?.()).toBe(false)

    const server = scopeRpcClientToExecutionHost(page.client, SERVER)
    await expect(server.sendRequest('worktree.ps', {})).rejects.toThrow(/update the Orca app/)
    expect(() => server.subscribe('terminal.subscribe', { terminal: 't1' }, () => {})).toThrow(
      /update the Orca app/
    )
    expect(page.frames().filter((frame) => frame.type !== 'ready')).toEqual([])
    page.client.close()
  })
})
