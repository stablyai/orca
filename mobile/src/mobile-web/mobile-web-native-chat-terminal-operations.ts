import {
  MobileWebNativeChatPrepareCommitPayloadSchema,
  MobileWebNativeChatPrepareCommitResultSchema,
  MobileWebNativeChatRespondPayloadSchema,
  MobileWebNativeChatSendMessagePayloadSchema,
  MobileWebNativeChatSendResultSchema,
  MobileWebNativeChatStopPayloadSchema,
  type MobileWebNativeChatSendResult
} from '../../../src/shared/mobile-web/native-chat-operation-contract'
import { pasteMobileNativeChatImagePaths } from '../session/mobile-native-chat-image-send'
import {
  MOBILE_NATIVE_CHAT_MIN_WRITE_TIMEOUT_MS,
  type MobileNativeChatSendOutcome
} from '../session/mobile-native-chat-send'
import { isTerminalSendRpcAccepted } from '../terminal/terminal-send-rpc-response'
import type { RpcClient } from '../transport/rpc-client'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import { typeAgentTuiCommand } from '../../../src/shared/agent-tui-command-typing'
import {
  assertCurrentMobileWebNativeChatPageBinding,
  resolveFreshMobileWebNativeChatPageBinding
} from './mobile-web-native-chat-binding'
import { validateMobileWebNativeChatDeadline } from './mobile-web-native-chat-deadline'
import type { MobileWebNativeChatAuthority } from './mobile-web-native-chat-authority'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

const TERMINAL_OPERATIONS = new Set(['sendMessage', 'prepareCommit', 'respond', 'stop'])

export function isMobileWebNativeChatTerminalOperation(operation: string): boolean {
  return TERMINAL_OPERATIONS.has(operation)
}

export async function executeMobileWebNativeChatTerminalOperation(args: {
  operation: string
  payload: unknown
  client: RpcClient
  terminalClientId: string
  workspaceAuthority: MobileWebWorkspaceAuthority
  nativeChatAuthority: MobileWebNativeChatAuthority
}): Promise<unknown> {
  if (args.operation === 'sendMessage') {
    const payload = MobileWebNativeChatSendMessagePayloadSchema.parse(args.payload)
    validateMobileWebNativeChatDeadline(payload.deadline)
    const binding = await resolveTerminalBinding(args, payload)
    const send = (
      text: string,
      enter: boolean,
      resolvedLaunchDraft?: typeof payload.resolvedLaunchDraft
    ) =>
      sendTerminal(
        args.client,
        binding.hostTerminalId!,
        text,
        enter,
        args.terminalClientId,
        payload.deadline,
        payload.typeCommand ? false : payload.clearInputFirst === true,
        resolvedLaunchDraft,
        () => assertCurrentBinding(args, payload, binding)
      )
    if (payload.typeCommand) {
      let writeIndex = 0
      const outcome = await typeAgentTuiCommand({
        command: payload.text,
        write: (key) => {
          const isSubmit = writeIndex === payload.text.length + 1
          writeIndex += 1
          return send(key, false, isSubmit ? payload.resolvedLaunchDraft : undefined)
        }
      })
      return sendResult(outcome)
    }
    return sendResult(await send(payload.text, true, payload.resolvedLaunchDraft))
  }
  if (args.operation === 'prepareCommit') {
    const payload = MobileWebNativeChatPrepareCommitPayloadSchema.parse(args.payload)
    validateMobileWebNativeChatDeadline(payload.deadline)
    const binding = await resolveTerminalBinding(args, payload)
    const prepared = await pasteMobileNativeChatImagePaths({
      client: args.client,
      terminal: binding.hostTerminalId!,
      deviceToken: args.terminalClientId,
      imagePaths: [],
      followedByText: false,
      deadline: payload.deadline,
      assertCurrent: () => assertCurrentBinding(args, payload, binding)
    })
    return MobileWebNativeChatPrepareCommitResultSchema.parse({ prepared })
  }
  if (args.operation === 'respond') {
    const payload = MobileWebNativeChatRespondPayloadSchema.parse(args.payload)
    validateMobileWebNativeChatDeadline(payload.deadline)
    const binding = await resolveTerminalBinding(args, payload)
    return sendResult(
      await sendTerminal(
        args.client,
        binding.hostTerminalId!,
        payload.text,
        payload.enter,
        args.terminalClientId,
        payload.deadline,
        false,
        undefined,
        () => assertCurrentBinding(args, payload, binding)
      )
    )
  }
  const payload = MobileWebNativeChatStopPayloadSchema.parse(args.payload)
  validateMobileWebNativeChatDeadline(payload.deadline)
  const binding = await resolveTerminalBinding(args, payload)
  return sendResult(
    await sendTerminal(
      args.client,
      binding.hostTerminalId!,
      String.fromCharCode(27),
      // Escape must not carry Return: the extra newline submits the agent's input line.
      false,
      args.terminalClientId,
      payload.deadline,
      false,
      undefined,
      () => assertCurrentBinding(args, payload, binding)
    )
  )
}

function resolveTerminalBinding(
  args: {
    client: RpcClient
    workspaceAuthority: MobileWebWorkspaceAuthority
    nativeChatAuthority: MobileWebNativeChatAuthority
  },
  payload: { workspaceId: string; sessionId: string }
) {
  return resolveFreshMobileWebNativeChatPageBinding(
    args,
    payload.workspaceId,
    payload.sessionId,
    true
  )
}

async function sendTerminal(
  client: RpcClient,
  terminal: string,
  text: string,
  enter: boolean,
  clientId: string,
  deadline: number,
  clearInputFirst: boolean,
  resolvedLaunchDraft: { text: string; createdAt: number } | undefined,
  assertCurrent: () => void
): Promise<MobileNativeChatSendOutcome> {
  const timeoutMs = deadline - Date.now()
  if (timeoutMs < MOBILE_NATIVE_CHAT_MIN_WRITE_TIMEOUT_MS) {
    return 'rejected'
  }
  assertCurrent()
  try {
    const response = await client.sendRequest(
      'terminal.send',
      {
        terminal,
        text: clearInputFirst ? `\x15${text}` : text,
        enter,
        client: { id: clientId, type: 'mobile' },
        ...(resolvedLaunchDraft ? { resolvedLaunchDraft } : {})
      },
      { timeoutMs, budgetSpansConnect: true }
    )
    return isTerminalSendRpcAccepted(response) ? 'accepted' : 'rejected'
  } catch (error) {
    return isRpcDeliveryUnknown(error) || isLogicalClientCutoverError(error)
      ? 'unknown'
      : 'rejected'
  }
}

function assertCurrentBinding(
  args: {
    workspaceAuthority: MobileWebWorkspaceAuthority
    nativeChatAuthority: MobileWebNativeChatAuthority
  },
  payload: { workspaceId: string; sessionId: string },
  binding: Awaited<ReturnType<typeof resolveTerminalBinding>>
): void {
  assertCurrentMobileWebNativeChatPageBinding(args, payload.workspaceId, payload.sessionId, binding)
}

function sendResult(outcome: MobileWebNativeChatSendResult['outcome']) {
  return MobileWebNativeChatSendResultSchema.parse({ outcome })
}
