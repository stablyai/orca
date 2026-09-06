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
  it('stops the agent with a bare Escape that cannot submit the input line', async () => {
    const sendRequest = vi.fn<RpcClient['sendRequest']>().mockResolvedValue({
      ok: true,
      result: { delivered: true }
    })
    const operations = nativeHostSessionNativeChatOperations(client(sendRequest))

    await operations.stop(target(), Date.now() + 15_000)

    expect(sendRequest).toHaveBeenCalledWith(
      'terminal.send',
      expect.objectContaining({ text: String.fromCharCode(27), enter: false }),
      expect.anything()
    )
  })

  it('keeps the legacy file inventory scoped to the workspace that produced it', async () => {
    const sendRequest = vi.fn<RpcClient['sendRequest']>(async (method, params) => {
      if (method === 'files.searchPaths') {
        return { ok: false, error: { code: 'method_not_found', message: 'unsupported' } }
      }
      const worktree = (params as { worktree: string }).worktree
      return {
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
