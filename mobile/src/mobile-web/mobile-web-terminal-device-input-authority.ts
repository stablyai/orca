import * as Clipboard from 'expo-clipboard'
import type { MobileWebTerminalDeviceInputResult } from '../../../src/shared/mobile-web/terminal-stream-contract'
import type { RpcClient } from '../transport/rpc-client'
import { isFloatingWorkspaceWorktreeId } from '../session/floating-workspace'
import {
  buildMobileImagePastePayload,
  prepareMobileClipboardImageBase64,
  saveMobileClipboardImageAsTempFile
} from '../session/mobile-clipboard-image'
import { resizeMobileClipboardImage } from '../session/mobile-clipboard-image-resizer'
import {
  ImageLibraryPermissionError,
  pickMobileImage,
  type MobileImageSource
} from '../session/mobile-image-source-picker'
import { createMobileNativeChatImagePreview } from '../session/mobile-native-chat-image-thumbnail'
import { getRepoIdFromMobileWorktreeId } from '../session/mobile-session-route-helpers'
import { buildMobileTerminalClipboardTextPayload } from '../session/mobile-terminal-clipboard-text'
import type { RpcFailure, RpcSuccess } from '../transport/types'

const MOBILE_TERMINAL_PASTE_MAX_BYTES = 256 * 1024

export type MobileWebPreparedTerminalDeviceInput = MobileWebTerminalDeviceInputResult & {
  readonly payload?: string
}

export async function prepareMobileWebClipboardPaste(args: {
  client: RpcClient
  hostWorkspaceId: string
  bracketedPaste: boolean
}): Promise<MobileWebPreparedTerminalDeviceInput> {
  const text = await Clipboard.getStringAsync()
  if (text.length > 0) {
    const payload = buildMobileTerminalClipboardTextPayload(text, {
      bracketedPasteMode: args.bracketedPaste,
      altScreen: false
    })
    if (new TextEncoder().encode(payload).byteLength > MOBILE_TERMINAL_PASTE_MAX_BYTES) {
      return { status: 'too-large' }
    }
    return { status: 'accepted', payload }
  }

  const image = await Clipboard.getImageAsync({ format: 'png' })
  if (!image) {
    return { status: 'empty' }
  }
  try {
    const base64 = await prepareMobileClipboardImageBase64(image, resizeMobileClipboardImage)
    const imagePath = await saveMobileClipboardImageAsTempFile(args.client, base64, {
      connectionId: await resolveMobileWebWorkspaceConnectionId(args.client, args.hostWorkspaceId)
    })
    return { status: 'accepted', payload: buildMobileImagePastePayload(imagePath) }
  } catch (error) {
    if (isImageTooLargeError(error)) {
      return { status: 'too-large' }
    }
    throw error
  }
}

export async function prepareMobileWebImageAttachment(args: {
  client: RpcClient
  hostWorkspaceId: string
  source: MobileImageSource
}): Promise<MobileWebPreparedTerminalDeviceInput> {
  try {
    const picked = await pickMobileImage(args.source)
    if (!picked) {
      return { status: 'cancelled' }
    }
    const imagePath = await saveMobileClipboardImageAsTempFile(args.client, picked.base64, {
      connectionId: await resolveMobileWebWorkspaceConnectionId(args.client, args.hostWorkspaceId)
    })
    return { status: 'accepted', payload: buildMobileImagePastePayload(imagePath) }
  } catch (error) {
    if (error instanceof ImageLibraryPermissionError) {
      return { status: 'permission-denied' }
    }
    if (isImageTooLargeError(error)) {
      return { status: 'too-large' }
    }
    throw error
  }
}

export type MobileWebPreparedNativeChatImageAttachment =
  | {
      status: 'accepted'
      hostPath: string
      previewUri: string
    }
  | {
      status: 'cancelled' | 'permission-denied' | 'too-large'
    }

export async function prepareMobileWebNativeChatImageAttachment(args: {
  client: RpcClient
  hostWorkspaceId: string
  source: MobileImageSource
}): Promise<MobileWebPreparedNativeChatImageAttachment> {
  try {
    const picked = await pickMobileImage(args.source)
    if (!picked) {
      return { status: 'cancelled' }
    }
    const previewUri = await createMobileNativeChatImagePreview(picked)
    const hostPath = await saveMobileClipboardImageAsTempFile(args.client, picked.base64, {
      connectionId: await resolveMobileWebWorkspaceConnectionId(args.client, args.hostWorkspaceId)
    })
    return { status: 'accepted', hostPath, previewUri }
  } catch (error) {
    if (error instanceof ImageLibraryPermissionError) {
      return { status: 'permission-denied' }
    }
    if (isImageTooLargeError(error)) {
      return { status: 'too-large' }
    }
    throw error
  }
}

async function resolveMobileWebWorkspaceConnectionId(
  client: RpcClient,
  hostWorkspaceId: string
): Promise<string | null> {
  if (isFloatingWorkspaceWorktreeId(hostWorkspaceId)) {
    return null
  }
  const response = await client.sendRequest('repo.list')
  if (!response.ok) {
    throw new Error((response as RpcFailure).error.message)
  }
  const repos = ((response as RpcSuccess).result as { repos?: MobileWebRepoSummary[] }).repos ?? []
  const repoId = getRepoIdFromMobileWorktreeId(hostWorkspaceId)
  return repos.find((repo) => repo.id === repoId)?.connectionId?.trim() || null
}

function isImageTooLargeError(error: unknown): boolean {
  return error instanceof Error && error.message === 'Clipboard image is too large'
}

type MobileWebRepoSummary = {
  readonly id: string
  readonly connectionId?: string | null
}
