import { createContext, useMemo } from 'react'
import type { RuntimeNativeChatFileContext } from '../../../src/shared/runtime-types'
import {
  terminalArtifactPathResolve,
  type MobileFilePreviewRpcSender
} from '../files/mobile-file-preview-operations'
import {
  loadMobileFilePreview,
  type MobileFilePreviewSource
} from '../files/mobile-file-preview-request'
import { routeNativeChatHref } from '../../../src/shared/native-chat-href-routing'

export type MobileNativeChatResourceSource = {
  client: MobileFilePreviewRpcSender
  hostId: string
  worktreeId: string
  nativeChatContext: RuntimeNativeChatFileContext
}

export const MobileNativeChatResourceContext = createContext<MobileNativeChatResourceSource | null>(
  null
)

export function useMobileNativeChatResourceSource(
  {
    client,
    hostId,
    worktreeId,
    activeSessionTabId
  }: {
    client: MobileFilePreviewRpcSender | null
    hostId: string
    worktreeId: string
    activeSessionTabId: string | null
  },
  sessionId: string | null
): MobileNativeChatResourceSource | null {
  return useMemo(
    () =>
      client && activeSessionTabId && sessionId
        ? {
            client,
            hostId,
            worktreeId,
            nativeChatContext: { tabId: activeSessionTabId, sessionId }
          }
        : null,
    [client, hostId, worktreeId, activeSessionTabId, sessionId]
  )
}

export async function readMobileNativeChatResource(
  source: MobileNativeChatResourceSource,
  reference: string
): Promise<string | null> {
  const route = routeNativeChatHref(reference)
  if (route.kind !== 'file') {
    return null
  }
  const reply = await terminalArtifactPathResolve.request(
    source.client,
    {
      worktree: `id:${source.worktreeId}`,
      pathText: route.pathText,
      nativeChatContext: source.nativeChatContext,
      crossWorkspace: true
    },
    { timeoutMs: 10_000 }
  )
  const resolved = terminalArtifactPathResolve.interpret(reply)
  if (
    !reply.ok &&
    (reply.error.code === 'method_not_found' || reply.error.code === 'invalid_params')
  ) {
    throw new Error('Update the Orca server to preview this chat image')
  }
  if (!resolved.accepted || !resolved.value.exists || resolved.value.isDirectory) {
    return null
  }
  const result = resolved.value
  const target = result.openTarget
  const worktreeId =
    typeof result.worktree === 'string' && result.worktree ? result.worktree : source.worktreeId
  let file: MobileFilePreviewSource
  if (target?.kind === 'absolute-file' && target.absolutePath && target.grantId) {
    file = {
      source: 'terminalArtifact',
      worktreeId,
      absolutePath: target.absolutePath,
      grantId: target.grantId,
      pathText: route.pathText,
      nativeChatContext: source.nativeChatContext
    }
  } else if (target?.kind === 'worktree-file' && typeof target.relativePath === 'string') {
    file = { source: 'worktree', worktreeId, relativePath: target.relativePath }
  } else {
    return null
  }
  const image = await loadMobileFilePreview(source.client, file)
  if (image.status === 'error' || image.status === 'waiting') {
    throw new Error(image.message)
  }
  return image.status === 'ready' && image.kind === 'image' ? image.dataUri : null
}
