// `agentSessionAttachment.*` — files a client attaches to a structured chat, stored on this host.
//
// Behind the same gate as `agentSession.*`: only a client that reads structured sessions may write
// into their store. A namespace of its own, because these reach the attachment store rather than
// the session host. Clients call them only where the host advertises
// `agent-session.attachments.v1`; an older host answers `method_not_found`.

import { defineMethod, type RpcContext } from '../core'
import {
  requireInstalledStructuredHost,
  structuredCallerFor
} from './structured-agent-session-gate'
import {
  AttachmentReadParams,
  AttachmentUploadAppendParams,
  AttachmentUploadIdParams,
  AttachmentUploadStartParams
} from '../../../../shared/rpc-contract/agent-session-attachment-params'
import { remoteFileContentBudget } from './files-remote-content-budget'
import type { AgentSessionAttachmentStore } from '../../../native-chat/agent-session-attachments/agent-session-attachment-store'
import { getAgentSessionAttachmentStore } from '../../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'

async function requireStore(
  ctx: RpcContext
): Promise<{ store: AgentSessionAttachmentStore; callerKey: string }> {
  await requireInstalledStructuredHost(ctx)
  const store = getAgentSessionAttachmentStore()
  if (!store) {
    throw new Error('Chat attachments are not available on this host')
  }
  return { store, callerKey: structuredCallerFor(ctx).callerKey }
}

export const STRUCTURED_AGENT_SESSION_ATTACHMENT_METHODS = [
  defineMethod({
    name: 'agentSessionAttachment.uploadStart',
    params: AttachmentUploadStartParams,
    handler: async (params, ctx) => {
      const { store, callerKey } = await requireStore(ctx)
      return store.startUpload({ callerKey, ...params })
    }
  }),
  defineMethod({
    name: 'agentSessionAttachment.uploadAppend',
    params: AttachmentUploadAppendParams,
    handler: async (params, ctx) => {
      const { store, callerKey } = await requireStore(ctx)
      return store.appendChunk({ callerKey, ...params })
    }
  }),
  defineMethod({
    name: 'agentSessionAttachment.uploadCommit',
    params: AttachmentUploadIdParams,
    handler: async (params, ctx) => {
      const { store, callerKey } = await requireStore(ctx)
      return store.commitUpload({ callerKey, uploadId: params.uploadId })
    }
  }),
  defineMethod({
    name: 'agentSessionAttachment.uploadAbort',
    params: AttachmentUploadIdParams,
    handler: async (params, ctx) => {
      const { store, callerKey } = await requireStore(ctx)
      return store.abortUpload({ callerKey, uploadId: params.uploadId })
    }
  }),
  defineMethod({
    name: 'agentSessionAttachment.read',
    params: AttachmentReadParams,
    handler: async (params, ctx) => {
      const { store } = await requireStore(ctx)
      // A remote reply must fit the connection's outbound budget, or the server closes the socket.
      return store.readPreview(params.path, remoteFileContentBudget(ctx.clientKind, ctx.requestId))
    }
  })
]
