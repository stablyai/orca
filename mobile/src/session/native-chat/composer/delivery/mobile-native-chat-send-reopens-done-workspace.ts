import { useCallback } from 'react'
import * as z from 'zod'
import { salvagedOptional } from '../../../../../../src/shared/validation/zod-salvage'
import { normalizeWorkspaceStatuses } from '../../../../../../src/shared/workspace/status/workspace-statuses'
import { workspaceStatusAfterChatSend } from '../../../../../../src/shared/workspace/status/workspace-status-reopen-on-send'
import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import {
  bindDeferredRpcOperation,
  defineRpcOperation
} from '../../../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../../../transport/rpc/rpc-operation-result-reader'
import type { MobileNativeChatController } from '../../mobile-native-chat-controller-contract'
import { worktreeStatusWrite } from '../../../../host-screen/workspace-actions/workspace-row-menu-operations'

// Undefined: the host did not say, so the status is left alone.
const worktreeStatusSchema = z
  .looseObject({
    worktree: salvagedOptional(
      'worktree',
      z.looseObject({ workspaceStatus: salvagedOptional('workspaceStatus', z.string()) })
    )
  })
  .transform((reply) => reply.worktree?.workspaceStatus)
  .catch(() => undefined)

const hostStatusColumnsSchema = z
  .looseObject({
    ui: salvagedOptional(
      'ui',
      z.looseObject({
        workspaceStatuses: salvagedOptional('workspaceStatuses', z.array(z.unknown()))
      })
    )
  })
  .transform((reply) => reply.ui?.workspaceStatuses)
  .catch(() => undefined)

const worktreeStatusRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.show-status-or-skip',
    method: 'worktree.show',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('worktree-status', worktreeStatusSchema)
  })
)

const hostStatusColumnsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'ui.workspace-status-columns-or-skip',
    method: 'ui.get',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('workspace-status-columns', hostStatusColumnsSchema)
  })
)

// Per client: the same workspace id on another host is another workspace.
const inFlight = new WeakMap<RpcClient, Set<string>>()

async function reopen(client: RpcClient, worktreeId: string): Promise<void> {
  const worktree = `id:${worktreeId}`
  const [status, columns] = await Promise.all([
    worktreeStatusRead.request(client, { worktree }),
    hostStatusColumnsRead.request(client)
  ])
  const statusRead = worktreeStatusRead.interpret(status)
  const columnsRead = hostStatusColumnsRead.interpret(columns)
  if (!statusRead.accepted || !columnsRead.accepted || columnsRead.value === undefined) {
    return
  }
  const next = workspaceStatusAfterChatSend(
    { workspaceStatus: statusRead.value },
    normalizeWorkspaceStatuses(columnsRead.value)
  )
  if (next) {
    await worktreeStatusWrite.request(client, { worktree, workspaceStatus: next })
  }
}

/** As on desktop: a message sent in a Done workspace's chat moves it back to In progress.
 *  Best-effort and detached, so a host that refuses any step never touches the send. */
export function reopenDoneWorkspaceAfterChatSend(
  client: RpcClient | null,
  worktreeId: string
): void {
  if (!client || !worktreeId) {
    return
  }
  const pending = inFlight.get(client) ?? new Set<string>()
  if (pending.has(worktreeId)) {
    return
  }
  pending.add(worktreeId)
  inFlight.set(client, pending)
  void reopen(client, worktreeId)
    .catch(() => {})
    .finally(() => pending.delete(worktreeId))
}

type ChatSends = Pick<
  MobileNativeChatController,
  'handleNativeChatSend' | 'handleNativeChatSendWithOutcome'
>

/** The chat's Send, offline queue and attachments all go through these two. */
export function useReopenDoneWorkspaceOnChatSend(
  client: RpcClient | null,
  worktreeId: string,
  sendWithOutcome: ChatSends['handleNativeChatSendWithOutcome']
): ChatSends {
  const handleNativeChatSendWithOutcome = useCallback<ChatSends['handleNativeChatSendWithOutcome']>(
    async (...args) => {
      const outcome = await sendWithOutcome(...args)
      if (outcome === 'accepted') {
        reopenDoneWorkspaceAfterChatSend(client, worktreeId)
      }
      return outcome
    },
    [client, sendWithOutcome, worktreeId]
  )
  // Same answer as both chats' own boolean Send; reopening follows the outcome, so an unconfirmed send does not.
  const handleNativeChatSend = useCallback<ChatSends['handleNativeChatSend']>(
    async (text, images) => (await handleNativeChatSendWithOutcome(text, images)) !== 'rejected',
    [handleNativeChatSendWithOutcome]
  )
  return { handleNativeChatSend, handleNativeChatSendWithOutcome }
}
