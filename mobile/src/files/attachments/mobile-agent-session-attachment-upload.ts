import * as z from 'zod'
import {
  base64DecodedByteLength,
  type AgentSessionAttachmentUploadCommitResult
} from '../../../../src/shared/agent-session/agent-session-attachments'
import type { PickedMobileFile } from '../../platform/media-picker-contract'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'

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

// DOMException is not a global in the native app; build the AbortError the way the bridge does.
function uploadAborted(): Error {
  return Object.assign(new Error('The upload was cancelled'), { name: 'AbortError' })
}

/** Sends the file chunk by chunk as it is read; signal is checked before every append and before commit. */
export async function uploadMobileAgentSessionAttachment(
  client: MobileAgentSessionAttachmentRpcSender,
  args: {
    sessionId: string
    file: PickedMobileFile
    signal?: AbortSignal
    onProgress?: (sentBytes: number) => void
  }
): Promise<AgentSessionAttachmentUploadCommitResult> {
  const { file, signal } = args
  if (signal?.aborted) {
    throw uploadAborted()
  }
  const { uploadId } = attachmentUploadStart.interpret(
    await attachmentUploadStart.request(client, {
      sessionId: args.sessionId,
      name: file.name,
      byteLength: file.byteLength
    })
  )
  try {
    let sent = 0
    const append = async (contentBase64: string): Promise<void> => {
      if (signal?.aborted) {
        throw uploadAborted()
      }
      attachmentUploadAppend.interpret(
        await attachmentUploadAppend.request(client, { uploadId, offset: sent, contentBase64 })
      )
      sent += base64DecodedByteLength(contentBase64)
      args.onProgress?.(sent)
    }
    let appended = false
    for await (const contentBase64 of file.chunks()) {
      await append(contentBase64)
      appended = true
    }
    if (!appended) {
      // Even an empty file needs one empty append before commit.
      await append('')
    }
    if (signal?.aborted) {
      throw uploadAborted()
    }
    return attachmentUploadCommit.interpret(
      await attachmentUploadCommit.request(client, { uploadId })
    )
  } catch (error) {
    await attachmentUploadAbort.request(client, { uploadId }).catch(() => {})
    throw error
  }
}
