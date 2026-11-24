import { buildImageDataUri } from '../../../../../src/shared/file-preview/image-data-uri'
import { isAgentSessionAttachmentStorePath } from '../../../../../src/shared/agent-session/agent-session-attachments'
import { PrioritySemaphore } from '../../../../../src/shared/concurrency/priority-semaphore'
import { filePreviewImageSchema } from '../../../files/preview/file-preview-reply-schema'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../../transport/rpc/rpc-operation-result-reader'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import { readAttachmentBase64InRanges } from '../../../../../src/shared/agent-session/agent-session-attachment-paged-read'
import { IMAGE_FILE_MIME_TYPES } from '../../../../../src/shared/file-preview/image-mime-types'
import { filePreviewExtension } from '../../../../../src/shared/file-preview/file-preview-kind'
import { createMobileChatAttachmentReader } from '../../../files/attachments/mobile-chat-attachment-read'

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
  /** Paired computer, so a dismissed subagent stays dismissed for this workspace. */
  hostId?: string
}

// A phone holds the whole image as a data URI string, so it pages fewer bytes than a desktop does.
const PAGED_STORED_IMAGE_MAX_BYTES = 10 * 1024 * 1024

// Each reply can be megabytes; a burst over a slow link overflows the host's outbound queue, which drops the socket.
const hostImageReads = new PrioritySemaphore(2)

// One host read at a time per slot; throws when aborted so a caller never runs without one.
async function withImageReadSlot<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  const release = await hostImageReads.acquire(0, signal)
  try {
    signal.throwIfAborted()
    return await read()
  } finally {
    release()
  }
}

const TOO_LARGE = Symbol('too large for one reply')

// Null on any failure, including older hosts that refuse these methods to phones: the row keeps its placeholder.
export async function readHostChatImage(
  { client, worktreeId }: MobileNativeChatImageSource,
  path: string,
  signal: AbortSignal
): Promise<string | null> {
  try {
    const options = { timeoutMs: 15_000, budgetSpansConnect: true }
    const image = await withImageReadSlot(signal, async () => {
      if (!isAgentSessionAttachmentStorePath(path)) {
        return hostImageRead.interpret(
          await hostImageRead.request(client, { worktree: `id:${worktreeId}`, path }, options)
        )
      }
      const reply = await storedImageRead.request(client, { path }, options)
      return !reply.ok && reply.error.message === 'file_too_large'
        ? TOO_LARGE
        : storedImageRead.interpret(reply)
    })
    if (image === TOO_LARGE) {
      return await readStoredImageInRanges(client, path, signal)
    }
    return image?.isImage && image.content ? buildImageDataUri(image.mimeType, image.content) : null
  } catch {
    return null
  }
}

/** A stored image too large for one reply, from hosts that read attachments in ranges; older hosts
 *  refuse in the reader and the row keeps its placeholder. Each range takes its own slot, so smaller
 *  images load between them. */
async function readStoredImageInRanges(
  client: RpcClient,
  path: string,
  signal: AbortSignal
): Promise<string | null> {
  const mimeType = IMAGE_FILE_MIME_TYPES[filePreviewExtension(path)]
  if (!mimeType) {
    return null
  }
  const read = createMobileChatAttachmentReader(client)
  const content = await readAttachmentBase64InRanges(
    (request) => withImageReadSlot(signal, () => read(request, signal)),
    path,
    PAGED_STORED_IMAGE_MAX_BYTES
  )
  return content === null ? null : buildImageDataUri(mimeType, content)
}
