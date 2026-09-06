import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebNativeChatAuthority } from './mobile-web-native-chat-authority'
import { executeMobileWebNativeChatOperation } from './mobile-web-native-chat-operations'
import { prepareMobileWebNativeChatImageAttachment } from './mobile-web-terminal-device-input-authority'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

vi.mock('./mobile-web-terminal-device-input-authority', () => ({
  prepareMobileWebNativeChatImageAttachment: vi.fn()
}))

const BINDING = {
  hostWorkspaceId: 'workspace-1',
  hostTabId: 'tab-1',
  hostTerminalId: 'terminal-secret',
  agent: 'claude',
  providerSessionId: 'provider-session-secret',
  transcriptPath: '/private/transcript.jsonl'
}

describe('mobile web native-chat image operations', () => {
  it('returns an opaque scoped reference instead of the uploaded host path', async () => {
    const context = operationContext()
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValue(success(sessionSnapshot()))
    vi.mocked(prepareMobileWebNativeChatImageAttachment).mockResolvedValue({
      status: 'accepted',
      hostPath: '/remote/private/orca-image.png',
      previewUri: 'data:image/jpeg;base64,preview'
    })

    const result = await executeMobileWebNativeChatOperation({
      ...operationArgs(context, sendRequest),
      operation: 'attachImage',
      payload: {
        workspaceId: context.pageWorkspaceId,
        sessionId: context.pageSessionId,
        source: 'files'
      }
    })

    expect(result).toMatchObject({
      status: 'accepted',
      attachment: {
        reference: expect.stringMatching(/^native_chat_image_[a-z0-9]+_[a-f0-9]{32}$/),
        previewUri: 'data:image/jpeg;base64,preview'
      }
    })
    expect(JSON.stringify(result)).not.toContain('/remote/private')
    const reference = (result as { attachment: { reference: string } }).attachment.reference
    expect(
      context.nativeChatAuthority.resolveImagePaths(
        BINDING.hostWorkspaceId,
        context.pageSessionId,
        [reference]
      )
    ).toEqual(['/remote/private/orca-image.png'])
  })

  it('clears stale composer input with the same bounded mobile client identity', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    try {
      const context = operationContext()
      const sendRequest = vi
        .fn<RpcClient['sendRequest']>()
        .mockResolvedValueOnce(success(sessionSnapshot()))
        .mockResolvedValueOnce(
          success({ send: { handle: 'terminal-secret', accepted: true, bytesWritten: 1 } })
        )

      await expect(
        executeMobileWebNativeChatOperation({
          ...operationArgs(context, sendRequest),
          operation: 'prepareCommit',
          payload: {
            workspaceId: context.pageWorkspaceId,
            sessionId: context.pageSessionId,
            deadline: 20_000
          }
        })
      ).resolves.toEqual({ prepared: true })
      expect(sendRequest).toHaveBeenNthCalledWith(
        2,
        'terminal.send',
        {
          terminal: 'terminal-secret',
          text: '\x15',
          enter: false,
          client: { id: 'mobile-device', type: 'mobile' }
        },
        { timeoutMs: 10_000, budgetSpansConnect: true }
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects an underfunded deadline before any host request', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    try {
      const context = operationContext()
      const sendRequest = vi.fn<RpcClient['sendRequest']>()

      await expect(
        executeMobileWebNativeChatOperation({
          ...operationArgs(context, sendRequest),
          operation: 'sendMessage',
          payload: {
            workspaceId: context.pageWorkspaceId,
            sessionId: context.pageSessionId,
            text: 'hello',
            deadline: 11_999
          }
        })
      ).rejects.toMatchObject({ code: 'invalid_request' })
      expect(sendRequest).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

function operationContext() {
  const workspaceAuthority = new MobileWebWorkspaceAuthority((length) => new Uint8Array(length))
  workspaceAuthority.synchronize([{ workspaceId: BINDING.hostWorkspaceId, repoId: 'repo-1' }])
  const nativeChatAuthority = new MobileWebNativeChatAuthority((length) => new Uint8Array(length))
  return {
    workspaceAuthority,
    nativeChatAuthority,
    pageWorkspaceId: workspaceAuthority.pageWorkspaceId(BINDING.hostWorkspaceId),
    pageSessionId: nativeChatAuthority.register(BINDING)
  }
}

function operationArgs(
  context: ReturnType<typeof operationContext>,
  sendRequest: RpcClient['sendRequest']
) {
  return {
    client: { sendRequest } as unknown as RpcClient,
    terminalClientId: 'mobile-device',
    workspaceAuthority: context.workspaceAuthority,
    nativeChatAuthority: context.nativeChatAuthority,
    nativeAuthority: {}
  }
}

function sessionSnapshot() {
  return {
    worktree: BINDING.hostWorkspaceId,
    tabs: [
      {
        type: 'terminal',
        id: BINDING.hostTabId,
        terminal: BINDING.hostTerminalId,
        launchAgent: BINDING.agent,
        agentStatus: {
          state: 'waiting',
          agentType: BINDING.agent,
          providerSession: {
            id: BINDING.providerSessionId,
            transcriptPath: BINDING.transcriptPath
          }
        }
      }
    ]
  }
}

function success(result: unknown) {
  return {
    id: 'response',
    ok: true as const,
    result,
    _meta: { runtimeId: 'runtime' }
  }
}
