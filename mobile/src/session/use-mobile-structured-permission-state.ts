import * as React from 'react'
import { useMemo } from 'react'
import {
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
  isAgentChatPermissionMode,
  type AgentSessionPermissionModes
} from '../../../src/shared/agent-chat-permission-mode'
import { useAgentSessionPermissionState } from '../../../src/shared/use-agent-session-permission-state'
import type { MobileStructuredAgentOptionsArgs } from './mobile-structured-options-controller'
import type { MobileNativeChatPermissionPickerState } from './MobileNativeChatPermissionPicker'

export function useMobileStructuredPermissionState(args: MobileStructuredAgentOptionsArgs) {
  const publication = useMemo(
    () =>
      args.permissionPublication ??
      (args.permissionMode === null || isAgentChatPermissionMode(args.permissionMode)
        ? { mode: args.permissionMode, fence: args.fence, revision: args.permissionRevision }
        : undefined),
    [args.permissionPublication, args.permissionMode, args.fence, args.permissionRevision]
  )
  return useAgentSessionPermissionState(
    {
      identity: JSON.stringify([args.sessionKey, args.agent, args.sessionId]),
      agent: args.agent ?? '',
      seed: args.permissionSeed,
      publication,
      fence: args.fence
    },
    React
  )
}

/** The pill's state; null where the host offers no picker for this chat. */
export function useMobilePermissionPicker(
  agent: string | null,
  permission: AgentSessionPermissionModes | null,
  pending: boolean,
  setOption: (id: string, value: string) => Promise<boolean>
): MobileNativeChatPermissionPickerState | null {
  return useMemo(
    () =>
      permission
        ? {
            provider: agent,
            ...permission,
            pending,
            setMode: (mode) => setOption(AGENT_CHAT_PERMISSION_MODE_OPTION_ID, mode)
          }
        : null,
    [agent, pending, permission, setOption]
  )
}
