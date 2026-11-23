import * as z from 'zod'
import {
  agentSessionAttachmentAppends,
  base64DecodedByteLength,
  type AgentSessionAttachmentUploadCommitResult
} from '../../../../src/shared/agent-session/agent-session-attachments'
import { agentSessionAttachmentByteAppends } from './mobile-attachment-byte-appends'
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

type AttachmentAppend = { offset: number; contentBase64: string }

type MobileAgentSessionAttachmentRpcSender = Parameters<typeof attachmentUploadStart.request>[0]

export async function uploadMobileAgentSessionAttachment(
  client: MobileAgentSessionAttachmentRpcSender,
  args: { sessionId: string; name: string; base64: string }
): Promise<AgentSessionAttachmentUploadCommitResult> {
  return uploadAppends(
    client,
    {
      sessionId: args.sessionId,
      name: args.name,
      byteLength: base64DecodedByteLength(args.base64)
    },
    agentSessionAttachmentAppends(args.base64)
  )
}

/** Streams a picked file from its source, so the phone never holds more than one append of it. */
export async function uploadMobileAgentSessionAttachmentBytes(
  client: MobileAgentSessionAttachmentRpcSender,
  args: { sessionId: string; name: string; byteLength: number; bytes: AsyncIterable<Uint8Array> }
): Promise<AgentSessionAttachmentUploadCommitResult> {
  return uploadAppends(
    client,
    { sessionId: args.sessionId, name: args.name, byteLength: args.byteLength },
    agentSessionAttachmentByteAppends(args.bytes)
  )
}

async function uploadAppends(
  client: MobileAgentSessionAttachmentRpcSender,
  start: { sessionId: string; name: string; byteLength: number },
  appends: Iterable<AttachmentAppend> | AsyncIterable<AttachmentAppend>
): Promise<AgentSessionAttachmentUploadCommitResult> {
  const { uploadId } = attachmentUploadStart.interpret(
    await attachmentUploadStart.request(client, start)
  )
  try {
    for await (const chunk of appends) {
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
