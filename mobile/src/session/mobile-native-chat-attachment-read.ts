import { createContext } from 'react'
import { isAgentSessionAttachmentStorePath } from '../../../src/shared/agent-session-attachments'
import { buildImageDataUri } from '../../../src/shared/image-data-uri'
import { filePreviewImageSchema } from '../files/file-preview-reply-schema'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'

const attachmentRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'agentSessionAttachment.preview-image',
    method: 'agentSessionAttachment.read',
    acceptance: 'object-result-or-null',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('file-preview-image', filePreviewImageSchema)
  })
)

type AttachmentClient = Parameters<typeof attachmentRead.request>[0]
export const MobileNativeChatAttachmentContext = createContext<AttachmentClient | null>(null)

export async function readMobileNativeChatAttachment(
  client: AttachmentClient,
  path: string
): Promise<string | null> {
  if (!isAgentSessionAttachmentStorePath(path)) {
    return null
  }
  const response = await attachmentRead.request(
    client,
    { path },
    {
      timeoutMs: 15_000,
      budgetSpansConnect: true
    }
  )
  const preview = attachmentRead.interpret(response)
  return preview?.isImage && typeof preview.content === 'string'
    ? buildImageDataUri(preview.mimeType, preview.content)
    : null
}
