import { describe, expect, it, vi } from 'vitest'
import { readMobileNativeChatResource } from './mobile-native-chat-resource-read'
import type { RpcResponse } from '../transport/types'

const context = { tabId: 'chat-1', sessionId: 'session-1' }
const path = '/mnt/data/chart.png'
const image = {
  id: 'reply',
  ok: true as const,
  result: { isImage: true, isBinary: true, mimeType: 'image/png', content: 'AAAA' }
}
function resolved(grantId = 'grant-1') {
  return {
    id: 'reply',
    ok: true as const,
    result: {
      exists: true,
      isDirectory: false,
      worktree: 'wt-1',
      openTarget: { kind: 'absolute-file', absolutePath: path, grantId, readOnly: true }
    }
  }
}

describe('assistant image reads on the conversation host', () => {
  it('uses the matching session grant and retains the selected host client', async () => {
    const sendRequest = vi.fn(async (method: string): Promise<RpcResponse> =>
      method === 'files.resolveTerminalPath' ? resolved() : image
    )
    expect(
      await readMobileNativeChatResource(
        {
          client: { sendRequest },
          hostId: 'host-1',
          worktreeId: 'wt-1',
          nativeChatContext: context
        },
        path
      )
    ).toBe('data:image/png;base64,AAAA')
    expect(sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'files.resolveTerminalPath',
      'files.readTerminalArtifactPreview'
    ])
    expect(sendRequest).toHaveBeenCalledWith(
      'files.resolveTerminalPath',
      { worktree: 'id:wt-1', pathText: path, nativeChatContext: context, crossWorkspace: true },
      { timeoutMs: 10_000 }
    )
  })
  it.each([
    { id: 'reply', ok: true as const, result: { exists: false, isDirectory: false } },
    {
      id: 'reply',
      ok: false as const,
      error: { code: 'forbidden', message: 'Not in this session' }
    }
  ])('does not read any file after a missing or refused resolution: $result', async (reply) => {
    const sendRequest = vi.fn(async (): Promise<RpcResponse> => reply)
    expect(
      await readMobileNativeChatResource(
        {
          client: { sendRequest },
          hostId: 'host-1',
          worktreeId: 'wt-1',
          nativeChatContext: context
        },
        path
      )
    ).toBeNull()
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })
  it('names the required host update when the resolver is unavailable', async () => {
    const sendRequest = vi.fn(async (): Promise<RpcResponse> => ({
      id: 'reply',
      ok: false,
      error: { code: 'method_not_found', message: 'Older host' }
    }))
    await expect(
      readMobileNativeChatResource(
        {
          client: { sendRequest },
          hostId: 'host-1',
          worktreeId: 'wt-1',
          nativeChatContext: context
        },
        path
      )
    ).rejects.toThrow('Update the Orca server')
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })
  it('renews an expired grant with the same conversation before retrying its read', async () => {
    const replies: RpcResponse[] = [
      resolved(),
      {
        id: 'reply',
        ok: false,
        error: { code: 'terminal_file_grant_expired', message: 'terminal_file_grant_expired' }
      },
      resolved('grant-2'),
      image
    ]
    const sendRequest = vi.fn(async (): Promise<RpcResponse> => replies.shift()!)
    expect(
      await readMobileNativeChatResource(
        {
          client: { sendRequest },
          hostId: 'host-1',
          worktreeId: 'wt-1',
          nativeChatContext: context
        },
        path
      )
    ).toBe('data:image/png;base64,AAAA')
    expect(sendRequest).toHaveBeenNthCalledWith(3, 'files.resolveTerminalPath', {
      worktree: 'id:wt-1',
      pathText: path,
      nativeChatContext: context
    })
    expect(sendRequest).toHaveBeenLastCalledWith('files.readTerminalArtifactPreview', {
      worktree: 'id:wt-1',
      absolutePath: path,
      grantId: 'grant-2'
    })
  })
  it('does not reinterpret an unreachable host as a local file', async () => {
    const sendRequest = vi.fn(async () => {
      throw new Error('Disconnected')
    })
    await expect(
      readMobileNativeChatResource(
        {
          client: { sendRequest },
          hostId: 'host-1',
          worktreeId: 'wt-1',
          nativeChatContext: context
        },
        path
      )
    ).rejects.toThrow('Disconnected')
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })
})
