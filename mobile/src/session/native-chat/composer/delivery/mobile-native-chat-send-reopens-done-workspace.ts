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
import type { useMobileNativeChatMessageSend } from '../../transcript/sending/use-mobile-native-chat-message-send'
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

type AcceptTerminalSend = Parameters<typeof useMobileNativeChatMessageSend>[0]['acceptSend']

/** Chat messages only, as on desktop: a terminal chat's accepted chat send (picked skills included) and
 *  a structured chat's accepted message; slash commands and goal changes never reopen. */
export function useReopenDoneWorkspaceOnChatSend(
  client: RpcClient | null,
  worktreeId: string,
  acceptSend: AcceptTerminalSend
): { acceptTerminalSend: AcceptTerminalSend; reopenAfterMessage: () => void } {
  const reopenAfterMessage = useCallback(
    () => reopenDoneWorkspaceAfterChatSend(client, worktreeId),
    [client, worktreeId]
  )
  // The terminal send calls this only for an accepted send its classification reads as chat.
  const acceptTerminalSend = useCallback<AcceptTerminalSend>(
    (...args) => {
      acceptSend(...args)
      reopenAfterMessage()
    },
    [acceptSend, reopenAfterMessage]
  )
  return { acceptTerminalSend, reopenAfterMessage }
}
