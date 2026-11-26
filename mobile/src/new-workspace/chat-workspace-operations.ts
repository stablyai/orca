import * as z from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'

export const chatWorkspaceCreate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.create-chat-workspace',
    method: 'repo.createChatWorkspace',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'chat-workspace-created',
      z.union([
        z.object({
          repo: z.looseObject({ id: z.string(), path: z.string(), displayName: z.string() })
        }),
        z.object({ error: z.string() })
      ])
    )
  })
)

export const chatWorkspaceNoteWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.set-chat-note',
    method: 'worktree.set',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('chat-note-written', z.unknown())
  })
)
