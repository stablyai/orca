import { buildImageDataUri } from '../../../../../src/shared/image-data-uri'
import { isAgentSessionAttachmentStorePath } from '../../../../../src/shared/agent-session-attachments'
import { PrioritySemaphore } from '../../../../../src/shared/priority-semaphore'
import { filePreviewImageSchema } from '../../../files/file-preview-reply-schema'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../../transport/rpc-operation'
import { rpcResultVariant } from '../../../transport/rpc-operation-result-reader'
import type { RpcClient } from '../../../transport/rpc-client'

// Accept device-loadable URI schemes only; a bare host/SSH path must remain a text placeholder.
const RENDERABLE_IMAGE_URI = /^(file:|data:|https?:|content:|blob:)/i

export function isRenderableImageUri(uri: string | undefined): uri is string {
  return typeof uri === 'string' && RENDERABLE_IMAGE_URI.test(uri)
}

const storedImageRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'agent-session-attachment.read-image',
    method: 'agentSessionAttachment.read',
    acceptance: 'object-result-or-null',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('chat-attachment-image', filePreviewImageSchema)
  })
)

const hostImageRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.read-chat-image',
    method: 'files.readChatImage',
    acceptance: 'object-result-or-null',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('chat-host-image', filePreviewImageSchema)
  })
)

/** The chat's host and workspace: store paths read from the attachment store, other host paths under desktop's chat-image rule. */
export type MobileNativeChatImageSource = {
  client: RpcClient
  worktreeId: string
}

// Each reply can be megabytes; a burst over a slow link overflows the host's outbound queue, which drops the socket.
const hostImageReads = new PrioritySemaphore(2)

// Null on any failure, including older hosts that refuse these methods to phones: the row keeps its placeholder.
export async function readHostChatImage(
  { client, worktreeId }: MobileNativeChatImageSource,
  path: string,
  signal: AbortSignal
): Promise<string | null> {
  const release = await hostImageReads.acquire(0, signal).catch(() => null)
  if (!release || signal.aborted) {
    release?.()
    return null
  }
  try {
    const options = { timeoutMs: 15_000, budgetSpansConnect: true }
    const image = isAgentSessionAttachmentStorePath(path)
      ? storedImageRead.interpret(await storedImageRead.request(client, { path }, options))
      : hostImageRead.interpret(
          await hostImageRead.request(client, { worktree: `id:${worktreeId}`, path }, options)
        )
    return image?.isImage && image.content ? buildImageDataUri(image.mimeType, image.content) : null
  } catch {
    return null
  } finally {
    release()
  }
}
