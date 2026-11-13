import * as z from 'zod'
import type { AgentSessionAttachmentUploadCommitResult } from '../../../../src/shared/agent-session/agent-session-attachments'
import type { PickedMobileFile } from '../../platform/media-picker-contract'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { interpretUploadReply, uploadFileInChunks } from './mobile-chunked-file-upload'
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

/** Sends the file chunk by chunk as it is read; signal is checked before every append and before commit. */
export function uploadMobileAgentSessionAttachment(
  client: MobileAgentSessionAttachmentRpcSender,
  args: {
    sessionId: string
    file: PickedMobileFile
    signal?: AbortSignal
    onProgress?: (sentBytes: number) => void
  }
): Promise<AgentSessionAttachmentUploadCommitResult> {
  return uploadFileInChunks({
    file: args.file,
    signal: args.signal,
    onProgress: args.onProgress,
    start: async () => {
      const reply = await attachmentUploadStart.request(client, {
        sessionId: args.sessionId,
        name: args.file.name,
        byteLength: args.file.byteLength
      })
      return interpretUploadReply(() => attachmentUploadStart.interpret(reply)).uploadId
    },
    append: async (uploadId, offset, contentBase64) => {
      const reply = await attachmentUploadAppend.request(client, {
        uploadId,
        offset,
        contentBase64
      })
      interpretUploadReply(() => attachmentUploadAppend.interpret(reply))
    },
    commit: async (uploadId) => {
      const reply = await attachmentUploadCommit.request(client, { uploadId })
      return interpretUploadReply(() => attachmentUploadCommit.interpret(reply))
    },
    abort: async (uploadId) => {
      await attachmentUploadAbort.request(client, { uploadId })
    }
  })
}
