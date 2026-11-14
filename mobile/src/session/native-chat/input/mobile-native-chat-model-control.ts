import { readHostStatusReply, decodeHostStatusReply } from '../../../query/host-status-query'
import { isRpcDeliveryUnknown } from '../../../transport/rpc/rpc-delivery-ambiguity'
import { isMethodNotFoundRefusal } from '../../../transport/rpc/rpc-acceptance-policies'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import { nativeChatTerminalModelControl } from './mobile-native-chat-options-operations'
import { isTuiAgent } from '../../../../../src/shared/agent-launch/catalog/tui-agent-config'
import { TERMINAL_MODEL_CONTROL_RUNTIME_CAPABILITY } from '../../../../../src/shared/terminal/runtime-policy/terminal-runtime-capabilities'
import type { TerminalModelControl } from '../../../../../src/shared/native-chat/input/native-chat-terminal-model-control'

export async function sendMobileNativeChatModelControl(args: {
  client: RpcClient
  terminal: string
  incarnationId?: string | null
  clientId: string
  control: TerminalModelControl
  isCurrent: () => boolean
}) {
  if (!isTuiAgent(args.control.agent)) {
    return null
  }
  const agent = args.control.agent
  const reply = await readHostStatusReply(args.client, {
    timeoutMs: 15_000,
    budgetSpansConnect: true
  }).catch(() => null)
  const status = reply ? decodeHostStatusReply(reply)?.status : null
  if (!status?.capabilities?.includes(TERMINAL_MODEL_CONTROL_RUNTIME_CAPABILITY)) {
    return null
  }
  const stale = new Error('model_control_target_changed')
  const blocked = { outcome: 'blocked' as const, reason: 'target-unavailable' as const, agent }
  if (!args.isCurrent()) {
    return blocked
  }
  let response: Awaited<ReturnType<typeof nativeChatTerminalModelControl.request>>
  try {
    response = await nativeChatTerminalModelControl.request(
      args.client,
      {
        ...args.control,
        agent,
        terminal: args.terminal,
        ...(args.incarnationId ? { expectedIncarnationId: args.incarnationId } : {}),
        client: { id: args.clientId, type: 'mobile' }
      },
      {
        timeoutMs: 65_000,
        budgetSpansConnect: true,
        failWhenDisconnected: true,
        beforeSend: () => {
          if (!args.isCurrent()) {
            throw stale
          }
        }
      }
    )
  } catch (error) {
    return error === stale || !isRpcDeliveryUnknown(error)
      ? blocked
      : { outcome: 'unknown' as const }
  }
  if (isMethodNotFoundRefusal(response)) {
    return null
  }
  const result = nativeChatTerminalModelControl.interpret(response)?.control ?? {
    outcome: 'unknown' as const
  }
  return result.outcome === 'legacy' ? null : result
}
