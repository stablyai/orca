import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebNativeChatAuthority } from './mobile-web-native-chat-authority'
import { executeMobileWebNativeChatOperation } from './mobile-web-native-chat-operations'
import { prepareMobileWebNativeChatImageAttachment } from './mobile-web-terminal-device-input-authority'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

vi.mock('./mobile-web-terminal-device-input-authority', () => ({
  prepareMobileWebNativeChatImageAttachment: vi.fn()
}))

const HOST_WORKSPACE_ID = 'workspace-1'
const SESSION_ID = 'provider-session'
const TABS = {
  worktree: HOST_WORKSPACE_ID,
  tabs: [
    {
      id: 'tab-1',
      type: 'terminal',
      terminal: 'terminal-secret',
      agentStatus: {
        agentType: 'claude',
        providerSession: { id: SESSION_ID, transcriptPath: '/private/transcript.jsonl' }
      }
    }
  ]
}

describe('mobile web native-chat image operations', () => {
  it('returns an opaque scoped reference instead of the uploaded host path', async () => {
    const context = operationContext()
    const sendRequest = vi.fn<RpcClient['sendRequest']>().mockResolvedValue(success(TABS))
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
        sessionId: context.sessionId,
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
      context.nativeChatAuthority.resolveImagePaths(HOST_WORKSPACE_ID, SESSION_ID, [reference])
    ).toEqual(['/remote/private/orca-image.png'])
  })
})

function operationContext() {
  const workspaceAuthority = new MobileWebWorkspaceAuthority((length) => new Uint8Array(length))
  workspaceAuthority.synchronize([HOST_WORKSPACE_ID])
  const nativeChatAuthority = new MobileWebNativeChatAuthority((length) => new Uint8Array(length))
  return {
    workspaceAuthority,
    nativeChatAuthority,
    pageWorkspaceId: workspaceAuthority.pageWorkspaceId(HOST_WORKSPACE_ID),
    sessionId: SESSION_ID
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

function success(result: unknown) {
  return {
    id: 'response',
    ok: true as const,
    result,
    _meta: { runtimeId: 'runtime' }
  }
}
