import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import { RpcIncompatibleReplyError } from '../transport/rpc-incompatible-reply-error'
import { PROJECT_RUNTIME_REPAIR_REQUIRED_CODE } from '../../../src/shared/project-runtime-repair-message'
import { SESSION_TABS_CHAT_FORK_CLI_RUNTIME_CAPABILITY } from '../../../src/shared/session-tabs-runtime-capabilities'
import type { RpcResponse } from '../transport/types'
import { createdTerminalDesktopWarning } from './session-write-reply-schema'

export function hostSupportsMobileChatFork(
  hostCapabilities: readonly string[] | undefined
): boolean {
  return hostCapabilities?.includes(SESSION_TABS_CHAT_FORK_CLI_RUNTIME_CAPABILITY) === true
}

export function mobileChatForkCreateReplyMessage(
  agentName: string,
  response: RpcResponse
): string | null {
  if (!response.ok) {
    return mobileChatForkRefusalMessage(agentName, response.error.code)
  }
  return createdTerminalDesktopWarning(response.result)
    ? `${agentName} opened in a CLI, but its desktop tab could not be shown. Check open tabs on the host before retrying.`
    : null
}

export function mobileChatForkRefusalMessage(agentName: string, code: string): string {
  const guidance =
    code === 'chat_fork_anchor_changed'
      ? 'Select a tab and try again.'
      : code === 'chat_fork_runtime_incompatible'
        ? 'Open the chat in a native workspace on its host and try again.'
        : code === 'chat_fork_source_unavailable'
          ? "Check that the chat has a saved conversation and review the agent's command and settings on the host, then try again."
          : code === PROJECT_RUNTIME_REPAIR_REQUIRED_CODE
            ? 'Review Project Runtime settings on the host and restore native Windows execution for this chat, then try again.'
            : 'Reconnect and check open tabs on the host before retrying.'
  return `Could not open ${agentName} in a new CLI. ${guidance}`
}

export function mobileChatForkRequestFailureMessage(agentName: string, error: unknown): string {
  return isRpcDeliveryUnknown(error) ||
    isLogicalClientCutoverError(error) ||
    error instanceof RpcIncompatibleReplyError
    ? `${agentName} may have opened. Reconnect and check open tabs on the host before retrying.`
    : `Could not open ${agentName} in a new CLI. Check the chat and host settings, then try again.`
}
