import { z } from 'zod'
import { WATCH_PROMPT_ALLOW_ACTION } from '../../../../src/shared/notifications/watch-prompt-reply'
import {
  acquireMobileNativeChatTerminalWrite,
  releaseMobileNativeChatTerminalWrite
} from '../../session/native-chat/composer/delivery/mobile-native-chat-terminal-write-lock'
import {
  MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS,
  type MobileNativeChatWriteOutcome
} from '../../session/native-chat/composer/delivery/mobile-native-chat-send'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import type { PendingWatchPrompt } from './watch-prompt-action'

export type WatchPromptOutcome = MobileNativeChatWriteOutcome | 'stale'

const watchPromptResolvePane = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'watch-prompt.resolve-pane',
    method: 'terminal.resolvePane',
    acceptance: 'object-result-or-null',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'watch-prompt-pane',
      z
        .looseObject({
          terminal: z.looseObject({ handle: z.string().min(1) })
        })
        .transform((value) => value.terminal.handle)
    )
  })
)

const watchPromptAgentStatus = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'watch-prompt.agent-status',
    method: 'terminal.agentStatus',
    acceptance: 'object-result-or-null',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'watch-prompt-status',
      z
        .looseObject({
          agentStatus: z
            .looseObject({
              status: z.enum(['working', 'permission', 'idle']).nullable()
            })
            .nullish()
        })
        .transform((value) => value.agentStatus?.status ?? null)
    )
  })
)

type WatchPromptRpcClient = Parameters<typeof watchPromptResolvePane.request>[0]

/** Types the watch's key only while this terminal still shows a permission prompt. */
export async function deliverWatchPromptReply(args: {
  client: WatchPromptRpcClient
  pending: PendingWatchPrompt
  send: (terminal: string, text: string) => Promise<MobileNativeChatWriteOutcome>
}): Promise<WatchPromptOutcome> {
  const options = { timeoutMs: MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS, budgetSpansConnect: true }
  let terminal: string | null
  try {
    terminal = watchPromptResolvePane.interpret(
      await watchPromptResolvePane.request(
        args.client,
        { paneKey: args.pending.paneKey, worktreeId: args.pending.worktreeId },
        options
      )
    )
  } catch {
    return 'rejected'
  }
  if (!terminal) {
    return 'stale'
  }
  // terminal.agentStatus only says whether a permission is still open.
  let status: 'working' | 'permission' | 'idle' | null
  try {
    status = watchPromptAgentStatus.interpret(
      await watchPromptAgentStatus.request(args.client, { terminal }, options)
    )
  } catch {
    return 'rejected'
  }
  if (status !== 'permission') {
    return 'stale'
  }
  const text =
    args.pending.action === WATCH_PROMPT_ALLOW_ACTION
      ? args.pending.reply.allow
      : args.pending.reply.deny
  if (!acquireMobileNativeChatTerminalWrite(terminal)) {
    return 'rejected'
  }
  try {
    return await args.send(terminal, text)
  } finally {
    releaseMobileNativeChatTerminalWrite(terminal)
  }
}
