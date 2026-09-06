import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import {
  buildMobileImagePastePayload,
  saveMobileClipboardImageAsTempFile
} from '../session/mobile-clipboard-image'
import { createMobileNativeChatImagePreview } from '../session/mobile-native-chat-image-thumbnail'
import { ImageLibraryPermissionError, pickMobileImage } from '../session/mobile-image-source-picker'
import {
  prepareMobileWebImageAttachment,
  prepareMobileWebNativeChatImageAttachment,
  type MobileWebPreparedTerminalDeviceInput
} from './mobile-web-terminal-device-input-authority'

vi.mock('expo-clipboard', () => ({
  getStringAsync: vi.fn(),
  getImageAsync: vi.fn()
}))

vi.mock('../session/mobile-clipboard-image', () => ({
  buildMobileImagePastePayload: vi.fn((filePath: string) => `\x1b[200~${filePath}\x1b[201~`),
  prepareMobileClipboardImageBase64: vi.fn(),
  saveMobileClipboardImageAsTempFile: vi.fn()
}))

vi.mock('../session/mobile-clipboard-image-resizer', () => ({
  resizeMobileClipboardImage: vi.fn()
}))

vi.mock('../session/mobile-native-chat-image-thumbnail', () => ({
  createMobileNativeChatImagePreview: vi.fn()
}))

vi.mock('../session/mobile-image-source-picker', () => {
  class MockImageLibraryPermissionError extends Error {
    constructor() {
      super('Photo library permission denied')
      this.name = 'ImageLibraryPermissionError'
    }
  }

  return {
    ImageLibraryPermissionError: MockImageLibraryPermissionError,
    pickMobileImage: vi.fn()
  }
})

function repoListClient(
  result: unknown = { repos: [{ id: 'repo-ssh', connectionId: 'connection-ssh' }] }
): Pick<RpcClient, 'sendRequest'> {
  return {
    sendRequest: vi.fn(async () => ({
      id: 'repo-list',
      ok: true as const,
      result,
      _meta: { runtimeId: 'runtime-1' }
    }))
  }
}

describe('prepareMobileWebImageAttachment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uploads through the SSH execution owner and returns a bracketed host path', async () => {
    vi.mocked(pickMobileImage).mockResolvedValue({ base64: 'AAAA' })
    vi.mocked(saveMobileClipboardImageAsTempFile).mockResolvedValue('/remote/orca-image.png')
    const client = repoListClient()

    const result = await prepareMobileWebImageAttachment({
      client: client as RpcClient,
      hostWorkspaceId: 'repo-ssh::/remote/worktree',
      source: 'library'
    })

    expect(pickMobileImage).toHaveBeenCalledWith('library')
    expect(saveMobileClipboardImageAsTempFile).toHaveBeenCalledWith(client, 'AAAA', {
      connectionId: 'connection-ssh'
    })
    expect(result).toEqual<MobileWebPreparedTerminalDeviceInput>({
      status: 'accepted',
      payload: buildMobileImagePastePayload('/remote/orca-image.png')
    })
  })

  it('keeps floating-workspace uploads local without listing repositories', async () => {
    vi.mocked(pickMobileImage).mockResolvedValue({ base64: 'BBBB' })
    vi.mocked(saveMobileClipboardImageAsTempFile).mockResolvedValue('/tmp/orca-image.png')
    const client = repoListClient()

    await prepareMobileWebImageAttachment({
      client: client as RpcClient,
      hostWorkspaceId: 'global-floating-terminal',
      source: 'files'
    })

    expect(client.sendRequest).not.toHaveBeenCalled()
    expect(saveMobileClipboardImageAsTempFile).toHaveBeenCalledWith(client, 'BBBB', {
      connectionId: null
    })
  })

  it('does not allocate an upload when the native picker is cancelled', async () => {
    vi.mocked(pickMobileImage).mockResolvedValue(null)
    const client = repoListClient()

    await expect(
      prepareMobileWebImageAttachment({
        client: client as RpcClient,
        hostWorkspaceId: 'repo-ssh::/remote/worktree',
        source: 'library'
      })
    ).resolves.toEqual({ status: 'cancelled' })
    expect(client.sendRequest).not.toHaveBeenCalled()
    expect(saveMobileClipboardImageAsTempFile).not.toHaveBeenCalled()
  })

  it('projects native permission denial without exposing its error', async () => {
    vi.mocked(pickMobileImage).mockRejectedValue(new ImageLibraryPermissionError())

    await expect(
      prepareMobileWebImageAttachment({
        client: repoListClient() as RpcClient,
        hostWorkspaceId: 'repo-ssh::/remote/worktree',
        source: 'library'
      })
    ).resolves.toEqual({ status: 'permission-denied' })
  })

  it('projects the bounded upload overflow without sending terminal input', async () => {
    vi.mocked(pickMobileImage).mockResolvedValue({ base64: 'CCCC' })
    vi.mocked(saveMobileClipboardImageAsTempFile).mockRejectedValue(
      new Error('Clipboard image is too large')
    )

    await expect(
      prepareMobileWebImageAttachment({
        client: repoListClient() as RpcClient,
        hostWorkspaceId: 'repo-ssh::/remote/worktree',
        source: 'library'
      })
    ).resolves.toEqual({ status: 'too-large' })
  })

  it('keeps the native-chat host path shell-only while returning a bounded preview', async () => {
    vi.mocked(pickMobileImage).mockResolvedValue({ base64: 'DDDD', uri: 'file:///image.jpg' })
    vi.mocked(createMobileNativeChatImagePreview).mockResolvedValue(
      'data:image/jpeg;base64,preview'
    )
    vi.mocked(saveMobileClipboardImageAsTempFile).mockResolvedValue('/remote/private-image.png')
    const client = repoListClient()

    await expect(
      prepareMobileWebNativeChatImageAttachment({
        client: client as RpcClient,
        hostWorkspaceId: 'repo-ssh::/remote/worktree',
        source: 'library'
      })
    ).resolves.toEqual({
      status: 'accepted',
      hostPath: '/remote/private-image.png',
      previewUri: 'data:image/jpeg;base64,preview'
    })
    expect(createMobileNativeChatImagePreview).toHaveBeenCalledWith({
      base64: 'DDDD',
      uri: 'file:///image.jpg'
    })
    expect(saveMobileClipboardImageAsTempFile).toHaveBeenCalledWith(client, 'DDDD', {
      connectionId: 'connection-ssh'
    })
  })
})
