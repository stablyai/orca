import * as z from 'zod'
import { salvagedOptional } from '../../../../src/shared/validation/zod-salvage'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import { hostScreenUnreadReplySchema, hostViewSettingsSchema } from '../host-screen-reply-schema'

// Null: a desktop from before per-workspace mute, whose strict ui.set would refuse the field.
const notificationMutesSchema = z
  .looseObject({
    ui: z.looseObject({
      notificationsMutedByWorktree: salvagedOptional(
        'notificationsMutedByWorktree',
        z.record(z.string(), z.boolean())
      )
    })
  })
  .transform((reply) => reply.ui.notificationsMutedByWorktree ?? null)
  .catch(() => null)

export const workspaceNotificationMutesRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'ui.workspace-notification-mutes-or-skip',
    method: 'ui.get',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('workspace-notification-mutes', notificationMutesSchema)
  })
)

export const workspaceNotificationMutesWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'ui.set-workspace-notification-mutes-or-skip',
    method: 'ui.set',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('workspace-notification-mutes-written', hostScreenUnreadReplySchema)
  })
)

// A server row's status columns are that server's own, as the desktop menu shows them.
export const workspaceStatusColumnsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'ui.workspace-status-columns-or-skip',
    method: 'ui.get',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('workspace-status-columns', hostViewSettingsSchema)
  })
)

// Optimistic row writes; a refusal puts the row back.
export const worktreeReadStateWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.set-unread-or-skip',
    method: 'worktree.set',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('unread-written', hostScreenUnreadReplySchema)
  })
)

export const worktreeStatusWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.set-status-or-skip',
    method: 'worktree.set',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('status-written', hostScreenUnreadReplySchema)
  })
)
