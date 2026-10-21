import { z } from 'zod'
import {
  agentSessionAttachmentAppends,
  base64DecodedByteLength,
  type AgentSessionAttachmentUploadCommitResult
} from '../../../src/shared/agent-session-attachments'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'

// A file the phone attaches to a structured chat, pumped into the host's attachment store: open a
// slot, append the bytes in chunks, commit. The agent only ever sees the host path it answers.

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

/** Stores `base64` in the host's attachment store for `sessionId`; aborts the slot on any failure. */
export async function uploadMobileAgentSessionAttachment(
  client: MobileAgentSessionAttachmentRpcSender,
  args: { sessionId: string; name: string; base64: string }
): Promise<AgentSessionAttachmentUploadCommitResult> {
  const { uploadId } = attachmentUploadStart.interpret(
    await attachmentUploadStart.request(client, {
      sessionId: args.sessionId,
      name: args.name,
      byteLength: base64DecodedByteLength(args.base64)
    })
  )
  try {
    for (const chunk of agentSessionAttachmentAppends(args.base64)) {
      attachmentUploadAppend.interpret(
        await attachmentUploadAppend.request(client, { uploadId, ...chunk })
      )
    }
    return attachmentUploadCommit.interpret(
      await attachmentUploadCommit.request(client, { uploadId })
    )
  } catch (error) {
    await attachmentUploadAbort.request(client, { uploadId }).catch(() => {})
    throw error
  }
}
