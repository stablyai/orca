import { sharedPromiseSettlementWaiters } from '../../../src/shared/promise-settlement-waiters'
import { hostStatusProbe } from '../transport/host-status-probe-operations'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  attachmentTextChunkSchema,
  type AttachmentTextRead
} from '../../../src/shared/attachment-text-source'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'

// Match the shared wire identifier without importing the host capability aggregate into this route.
const AGENT_SESSION_TEXT_ATTACHMENT_READ_CAPABILITY = 'native-chat.text-attachment-read.v1'

const textRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'chat-attachment.text-chunk',
    method: 'agentSessionAttachment.readTextChunk',
    acceptance: 'object-result-or-null',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('attachment-text-chunk', attachmentTextChunkSchema)
  })
)

type AttachmentReaderClient = RpcOperationSender &
  Pick<RpcClient, 'getState' | 'getLastConnectedAt' | 'getGeneration'>

export function createMobileChatAttachmentReader(
  client: AttachmentReaderClient | null
): AttachmentTextRead {
  const connectedAt = client?.getLastConnectedAt()
  const generation = client?.getGeneration?.()
  let status: ReturnType<typeof hostStatusProbe.request> | undefined
  const assertCurrent = () => {
    if (
      !client ||
      client.getState() !== 'connected' ||
      client.getLastConnectedAt() !== connectedAt ||
      client.getGeneration?.() !== generation
    ) {
      throw new Error('Connection changed. Retry to reopen the attachment.')
    }
  }
  return Object.assign(
    async (request: Parameters<typeof textRead.request>[1], signal?: AbortSignal) => {
      signal?.throwIfAborted()
      assertCurrent()
      if (!request.expectedSnapshot) {
        status = undefined
      }
      status ??= hostStatusProbe.request(client!, undefined, {
        signal,
        timeoutMs: 15_000,
        failWhenDisconnected: true,
        beforeSend: assertCurrent
      })
      const statusReply = await sharedPromiseSettlementWaiters(status).wait({
        signal,
        timeoutMs: 15_000
      })
      signal?.throwIfAborted()
      assertCurrent()
      const runtimeId = statusReply._meta?.runtimeId
      const host = hostStatusProbe.interpret(statusReply)
      if (
        !host.accepted ||
        !host.value?.capabilities?.includes(AGENT_SESSION_TEXT_ATTACHMENT_READ_CAPABILITY)
      ) {
        throw new Error(
          'This host cannot open text attachments yet. Update Orca on that host, then retry.'
        )
      }
      const reply = await sharedPromiseSettlementWaiters(
        textRead.request(client!, request, {
          timeoutMs: 15_000,
          failWhenDisconnected: true,
          beforeSend: assertCurrent,
          signal
        })
      ).wait({ signal, timeoutMs: 15_000 })
      signal?.throwIfAborted()
      assertCurrent()
      if (runtimeId && reply._meta?.runtimeId !== runtimeId) {
        throw new Error('The attachment host changed. Close it and reopen it.')
      }
      const chunk = textRead.interpret(reply)
      if (!chunk) {
        throw new Error(
          'Unable to read this attachment. Reconnect and try again. The file may have been removed or changed.'
        )
      }
      return chunk
    },
    { assertCurrent }
  )
}
