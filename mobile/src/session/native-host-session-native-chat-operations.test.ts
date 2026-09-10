import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { HostSessionNativeChatTarget } from './host-session-native-chat-operations'
import { nativeHostSessionNativeChatOperations } from './native-host-session-native-chat-operations'

function target(overrides: Partial<HostSessionNativeChatTarget> = {}): HostSessionNativeChatTarget {
  return {
    workspaceId: 'wt-1',
    agent: 'claude',
    sessionId: 'session-1',
    transcriptPath: null,
    terminalId: 'terminal-1',
    clientId: 'device-1',
    ...overrides
  }
}

function client(sendRequest: RpcClient['sendRequest']): RpcClient {
  return { sendRequest } as unknown as RpcClient
}

describe('native host session native chat operations', () => {
  it('stops the agent with a bare Escape that carries no enter at all', async () => {
    const sendRequest = vi.fn<RpcClient['sendRequest']>().mockResolvedValue({
      id: 'test',
      _meta: { runtimeId: 'host' },
      ok: true,
      result: { delivered: true }
    })
    const operations = nativeHostSessionNativeChatOperations(client(sendRequest))

    await operations.stop(target(), Date.now() + 15_000)

    const params = sendRequest.mock.calls[0]?.[1] as Record<string, unknown>
    expect(sendRequest.mock.calls[0]?.[0]).toBe('terminal.send')
    expect(params.text).toBe(String.fromCharCode(27))
    // The host tests `enter === true`, and the call it replaced omitted the field entirely.
    expect(params).not.toHaveProperty('enter')
  })

  it('still attempts the Escape inside the shared write floor', async () => {
    // The shared chat write refuses to start under a 2s residual budget. Stop does not: the
    // call it replaced tried on whatever was left and could be accepted.
    const sendRequest = vi.fn<RpcClient['sendRequest']>().mockResolvedValue({
      id: 'test',
      _meta: { runtimeId: 'host' },
      ok: true,
      result: { send: { accepted: true } }
    })
    const operations = nativeHostSessionNativeChatOperations(client(sendRequest))

    await expect(operations.stop(target(), Date.now() + 1_500)).resolves.toBe('accepted')
    // The second call is the worker-takeover report an accepted Stop always makes.
    const sends = sendRequest.mock.calls.filter(([method]) => method === 'terminal.send')
    expect(sends).toHaveLength(1)
    expect(sends[0]?.[2]).toMatchObject({ budgetSpansConnect: true })
  })

  it('does not attempt an Escape whose budget is already spent', async () => {
    const sendRequest = vi.fn<RpcClient['sendRequest']>()
    const operations = nativeHostSessionNativeChatOperations(client(sendRequest))

    await expect(operations.stop(target(), Date.now() - 1)).resolves.toBe('rejected')
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('ignores an older inventory completion after cache reset', async () => {
    const deferred: Array<(value: Awaited<ReturnType<RpcClient['sendRequest']>>) => void> = []
    const sendRequest = vi.fn<RpcClient['sendRequest']>((method) => {
      if (method === 'files.searchPaths') {
        return Promise.resolve({
          id: 'test',
          _meta: { runtimeId: 'host' },
          ok: false,
          error: { code: 'method_not_found', message: 'unsupported' }
        })
      }
      return new Promise((resolve) => deferred.push(resolve))
    })
    const operations = nativeHostSessionNativeChatOperations(client(sendRequest))
    const old = operations.searchFiles(target(), 'fresh')
    await vi.waitFor(() => expect(deferred).toHaveLength(1))
    const overlapping = operations.searchFiles(target(), 'old')
    operations.resetFileSearchCache('wt-1')
    const fresh = operations.searchFiles(target(), 'fresh')
    await vi.waitFor(() => expect(deferred).toHaveLength(2))
    deferred[1]!({
      id: 'test',
      _meta: { runtimeId: 'host' },
      ok: true,
      result: { files: [{ relativePath: 'fresh.ts' }] }
    })
    await expect(fresh).resolves.toEqual(['fresh.ts'])
    deferred[0]!({
      id: 'test',
      _meta: { runtimeId: 'host' },
      ok: true,
      result: { files: [{ relativePath: 'old.ts' }] }
    })
    await expect(old).resolves.toBeNull()
    await expect(overlapping).resolves.toBeNull()
    await expect(operations.searchFiles(target(), 'fresh')).resolves.toEqual(['fresh.ts'])
  })

  it('keeps the legacy file inventory scoped to the workspace that produced it', async () => {
    const sendRequest = vi.fn<RpcClient['sendRequest']>(async (method, params) => {
      if (method === 'files.searchPaths') {
        return {
          id: 'test',
          _meta: { runtimeId: 'host' },
          ok: false,
          error: { code: 'method_not_found', message: 'unsupported' }
        }
      }
      const worktree = (params as { worktree: string }).worktree
      return {
        id: 'test',
        _meta: { runtimeId: 'host' },
        ok: true,
        result: {
          files:
            worktree === 'id:wt-1'
              ? [{ relativePath: 'alpha/one.ts' }]
              : [{ relativePath: 'beta/two.ts' }]
        }
      }
    })
    const operations = nativeHostSessionNativeChatOperations(client(sendRequest))

    await expect(operations.searchFiles(target(), 'o')).resolves.toEqual(['alpha/one.ts'])
    // A second workspace must re-read; the first workspace's inventory is not its own.
    await expect(operations.searchFiles(target({ workspaceId: 'wt-2' }), 'o')).resolves.toEqual([
      'beta/two.ts'
    ])
    // The first workspace still answers from its cached inventory.
    await expect(operations.searchFiles(target(), 'o')).resolves.toEqual(['alpha/one.ts'])
    expect(sendRequest.mock.calls.filter(([method]) => method === 'files.list')).toHaveLength(2)
  })
})
