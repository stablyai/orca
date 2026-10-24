import { useCallback } from 'react'
import type { AgentSessionQueuedMessage } from '../../../src/shared/agent-session-wire'
import { queuedMessageEditableText } from '../../../src/shared/queued-message-edit'
import { promptMarkersToImageReferences } from '../../../src/shared/native-chat-image-transcript-markers'
import {
  appendMobileNativeChatDraft,
  captureMobileChatDraftOwner,
  updateMobileNativeChatDraftImages,
  type MobileChatDraftCopy
} from './mobile-native-chat-draft-store'
import { fileTapPathResolve } from './mobile-session-launch-operations'
import { loadMobileFilePreview } from '../files/mobile-file-preview-request'
import { structuredSessionOperationId } from './structured-session-operation-id'

export type MobileQueuedMessageCopy = (
  message: AgentSessionQueuedMessage
) => Promise<MobileChatDraftCopy | false>

/** Captures the source draft, retaining references without another upload or sender identity. */
export function copyMobileQueuedMessageToDraft(
  scope: string,
  message: AgentSessionQueuedMessage,
  client?: Parameters<typeof fileTapPathResolve.request>[0] | null
): Promise<MobileChatDraftCopy | false> {
  const text = queuedMessageEditableText(message.body)
  if (text === null) {
    return Promise.resolve(false)
  }
  const attempt = structuredSessionOperationId()
  const images = message.body.blocks.flatMap((block, index) => {
    if (block.type !== 'image-ref') {
      return []
    }
    const { type: _type, ...reference } = block
    return [
      {
        id: `edit-${attempt}-${index}`,
        path: block.path ?? '',
        reference,
        previewUri: block.url ?? ''
      }
    ]
  })
  const copied = appendMobileNativeChatDraft(scope, {
    text: promptMarkersToImageReferences(
      text,
      images.map((image) => image.id)
    ),
    images,
    skills: message.body.skills
  })
  const owner = captureMobileChatDraftOwner(scope)
  void copied.then((saved) => {
    if (!saved || !client) {
      return
    }
    const worktreeId = scope.split('\0')[1]
    if (!worktreeId) {
      return
    }
    for (const image of images) {
      if (!image.path || image.previewUri) {
        continue
      }
      void (async () => {
        const reply = await fileTapPathResolve.request(
          client,
          { worktree: `id:${worktreeId}`, pathText: image.path, crossWorkspace: true },
          { timeoutMs: 5000 }
        )
        const result = fileTapPathResolve.interpret(reply)
        if (!result.accepted) {
          return
        }
        const resolved = result.value
        if (
          !resolved.exists ||
          resolved.isDirectory ||
          resolved.openTarget?.kind === 'absolute-file'
        ) {
          return
        }
        const path =
          resolved.openTarget?.kind === 'worktree-file' && 'relativePath' in resolved.openTarget
            ? resolved.openTarget.relativePath
            : resolved.relativePath
        if (typeof path !== 'string') {
          return
        }
        const workspace =
          typeof resolved.worktree === 'string' && resolved.worktree
            ? resolved.worktree
            : worktreeId
        const preview = await loadMobileFilePreview(client, workspace, path)
        if (preview.status !== 'ready' || preview.kind !== 'image') {
          return
        }
        updateMobileNativeChatDraftImages(
          owner,
          (current) =>
            current.map((held) =>
              held.id === image.id ? { ...held, previewUri: preview.dataUri } : held
            ),
          true
        )
      })().catch(() => undefined)
    }
  })
  return copied
}

export function useMobileQueuedMessageCopy(
  draftScope: string | null,
  client: Parameters<typeof fileTapPathResolve.request>[0] | null
): MobileQueuedMessageCopy {
  return useCallback<MobileQueuedMessageCopy>(
    (message) =>
      draftScope
        ? copyMobileQueuedMessageToDraft(draftScope, message, client)
        : Promise.resolve(false),
    [draftScope, client]
  )
}
