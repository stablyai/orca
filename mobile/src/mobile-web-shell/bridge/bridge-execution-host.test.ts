import { describe, expect, it, vi } from 'vitest'
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

describe('executionHost across the shell bridge', () => {
  it('reaches the shell client on both doors and keeps untargeted calls as they were', async () => {
    const shell = recordingShellClient()
    const pair = createBridgePortPair({ rpc: shell.client })
    await pair.flush()
    expect(pair.client.carriesExecutionHost?.()).toBe(true)

    void pair.client.sendRequest('worktree.ps', { limit: 1 }, { executionHost: SERVER })
    void pair.client.sendRequest('worktree.ps', { limit: 1 })
    pair.client.subscribe('terminal.subscribe', { terminal: 't1' }, () => {}, {
      executionHost: SERVER
    })
    pair.client.subscribe('terminal.subscribe', { terminal: 't2' }, () => {})
    await pair.flush()

    expect(shell.sendRequest.mock.calls).toEqual([
      ['worktree.ps', { limit: 1 }, { executionHost: SERVER }],
      ['worktree.ps', { limit: 1 }]
    ])
    expect(shell.subscribe.mock.calls.map((call) => call[3])).toEqual([
      { executionHost: SERVER },
      undefined
    ])
  })

  it('refuses a target under a shell that would strip it, instead of running it on the desktop', async () => {
    const page = createPageClient()
    page.deliver({ ...INIT, grants: { ...INIT.grants, native: [] } })
    expect(page.client.carriesExecutionHost?.()).toBe(false)

    await expect(
      page.client.sendRequest('worktree.ps', {}, { executionHost: SERVER })
    ).rejects.toThrow(/cannot reach workspaces on other computers/)
    expect(() =>
      page.client.subscribe('terminal.subscribe', { terminal: 't1' }, () => {}, {
        executionHost: SERVER
      })
    ).toThrow(/cannot reach workspaces on other computers/)
    expect(page.frames().filter((frame) => frame.type !== 'ready')).toEqual([])
  })
})
