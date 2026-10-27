import { buildImageDataUri } from '../../../../../src/shared/image-data-uri'
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

// Each reply can be megabytes; a burst over a slow link overflows the host's outbound queue, which drops the socket.
const storedImageReads = new PrioritySemaphore(2)

// Null on any failure, including older hosts that refuse this method to phones: the row keeps its placeholder.
export async function readStoredChatImage(
  client: RpcClient,
  path: string,
  signal: AbortSignal
): Promise<string | null> {
  const release = await storedImageReads.acquire(0, signal).catch(() => null)
  if (!release || signal.aborted) {
    release?.()
    return null
  }
  try {
    const reply = await storedImageRead.request(
      client,
      { path },
      { timeoutMs: 15_000, budgetSpansConnect: true }
    )
    const image = storedImageRead.interpret(reply)
    return image?.isImage && image.content ? buildImageDataUri(image.mimeType, image.content) : null
  } catch {
    return null
  } finally {
    release()
  }
}
