import * as z from 'zod'
import {
  base64DecodedByteLength,
  type AgentSessionAttachmentUploadCommitResult
} from '../../../../src/shared/agent-session/agent-session-attachments'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import { MobileUploadCancelledError } from '../../platform/media-picking/media-picker-contract'

const uploadSlotSchema = z.looseObject({ uploadId: z.string() })
const storedAttachmentSchema = z.looseObject({
  path: z.string(),
  name: z.string(),
  byteLength: z.number()
})

const attachmentUploadStart = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'agent-session-attachment.upload-start',
    method: 'agentSessionAttachment.uploadStart',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('agent-session-attachment-upload-slot', uploadSlotSchema)
  })
)

const attachmentUploadAppend = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'agent-session-attachment.upload-append',
    method: 'agentSessionAttachment.uploadAppend',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('agent-session-attachment-chunk-appended', z.unknown())
  })
)

const attachmentUploadCommit = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'agent-session-attachment.upload-commit',
    method: 'agentSessionAttachment.uploadCommit',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('agent-session-attachment-stored', storedAttachmentSchema)
  })
)

/** Its own outcome is discarded: the failure that brought the caller here is the one to report. */
const attachmentUploadAbort = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'agent-session-attachment.upload-abort-or-skip',
    method: 'agentSessionAttachment.uploadAbort',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('agent-session-attachment-upload-aborted', z.unknown())
  })
)

type MobileAgentSessionAttachmentRpcSender = Parameters<typeof attachmentUploadStart.request>[0]

export async function uploadMobileAgentSessionAttachment(
  client: MobileAgentSessionAttachmentRpcSender,
  args: {
    /** Omitted for a file headed to a terminal, which has no chat session. */
    sessionId?: string
    name: string
    byteLength: number
    chunks: AsyncIterable<string>
    /** Bytes the host has acknowledged so far. */
    onProgress?: (sentBytes: number) => void
    /** Polled before each chunk; a true stops the upload and removes the partial file on the host. */
    shouldCancel?: () => boolean
  }
): Promise<AgentSessionAttachmentUploadCommitResult> {
  const { uploadId } = attachmentUploadStart.interpret(
    await attachmentUploadStart.request(client, {
      ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
      name: args.name,
      byteLength: args.byteLength
    })
  )
  try {
    let offset = 0
    for await (const contentBase64 of args.chunks) {
      if (args.shouldCancel?.()) {
        throw new MobileUploadCancelledError()
      }
      attachmentUploadAppend.interpret(
        await attachmentUploadAppend.request(client, { uploadId, offset, contentBase64 })
      )
      offset += base64DecodedByteLength(contentBase64)
      args.onProgress?.(offset)
    }
    if (offset === 0) {
      // Even an empty file needs one empty append before commit.
      attachmentUploadAppend.interpret(
        await attachmentUploadAppend.request(client, { uploadId, offset: 0, contentBase64: '' })
      )
    }
    if (args.shouldCancel?.()) {
      throw new MobileUploadCancelledError()
    }
    return attachmentUploadCommit.interpret(
      await attachmentUploadCommit.request(client, { uploadId })
    )
  } catch (error) {
    await attachmentUploadAbort.request(client, { uploadId }).catch(() => {})
    // A request that fails because the user cancelled is the cancel, not a failure to report.
    throw args.shouldCancel?.() ? new MobileUploadCancelledError() : error
  }
}
