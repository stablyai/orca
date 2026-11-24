// Store client chat attachments on this host under the structured-session gate, separate from session-host access.
// Negotiate attachments.v1; older hosts return method_not_found.

import { defineMethod, type RpcContext } from '../../../core'
import {
  requireInstalledStructuredHost,
  structuredCallerFor
} from '../creation/structured-agent-session-gate'
import {
  AttachmentReadParams,
  AttachmentTextReadParams,
  AttachmentUploadAppendParams,
  AttachmentUploadIdParams,
  AttachmentUploadStartParams
} from '../../../../../../shared/rpc-contract/structured-agent-session/agent-session-attachment-params'
import { remoteFileContentBudget } from '../../files/files-remote-content-budget'
import type { AgentSessionAttachmentStore } from '../../../../../native-chat/agent-session-attachments/agent-session-attachment-store'
import { getAgentSessionAttachmentStore } from '../../../../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import { ownerOnly } from '../../bots-caller-gates'
import { resolveItem } from '../../bots-items-write-support'

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
    name: 'agentSessionAttachment.readTextChunk',
    permission: 'workspace',
    params: AttachmentTextReadParams,
    handler: async (params, ctx) => {
      const { store } = await requireStore(ctx)
      return store.readTextChunk(params, remoteFileContentBudget(ctx.clientKind, ctx.requestId))
    }
  }),
  defineMethod({
    name: 'agentSessionAttachment.uploadStart',
    permission: 'workspace',
    params: AttachmentUploadStartParams,
    handler: async (params, ctx) => {
      if ('item' in params) {
        ownerOnly(ctx, 'Only your owner attaches files to item replies in Orca.')
        const { runtime } = ctx
        runtime.bots.assertEnabled()
        const item = await resolveItem(runtime.botItems.store(), params.item)
        if (!runtime.bots.list().some((bot) => bot.id === item.ownerBotId)) {
          throw new Error('The bot that owns this item is gone')
        }
        const { store, callerKey } = await requireStore(ctx)
        return store.stageUpload({ callerKey, name: params.name, byteLength: params.byteLength })
      }
      const { store, callerKey } = await requireStore(ctx)
      return store.startUpload({ callerKey, ...params })
    }
  }),
  defineMethod({
    name: 'agentSessionAttachment.uploadAppend',
    permission: 'workspace',
    params: AttachmentUploadAppendParams,
    handler: async (params, ctx) => {
      const { store, callerKey } = await requireStore(ctx)
      return store.appendChunk({ callerKey, ...params })
    }
  }),
  defineMethod({
    name: 'agentSessionAttachment.uploadCommit',
    permission: 'workspace',
    params: AttachmentUploadIdParams,
    handler: async (params, ctx) => {
      const { store, callerKey } = await requireStore(ctx)
      return store.commitUpload({ callerKey, uploadId: params.uploadId })
    }
  }),
  defineMethod({
    name: 'agentSessionAttachment.uploadAbort',
    permission: 'workspace',
    params: AttachmentUploadIdParams,
    handler: async (params, ctx) => {
      const { store, callerKey } = await requireStore(ctx)
      return store.abortUpload({ callerKey, uploadId: params.uploadId })
    }
  }),
  defineMethod({
    name: 'agentSessionAttachment.read',
    permission: 'workspace',
    params: AttachmentReadParams,
    handler: async (params, ctx) => {
      const { store } = await requireStore(ctx)
      // Bound remote replies or outbound-budget overflow closes the socket.
      return store.readPreview(params.path, remoteFileContentBudget(ctx.clientKind, ctx.requestId))
    }
  })
]
