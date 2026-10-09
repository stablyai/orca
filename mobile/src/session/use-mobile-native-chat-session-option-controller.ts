import type { RpcClient } from '../transport/rpc-client'
import { useMobileOmpModelDiscovery } from './use-mobile-omp-model-discovery'
import type { AgentSessionConversationCommand } from '../../../src/shared/agent-session-conversation-command'
import { useCallback, useMemo } from 'react'
import type {
  SessionOptionDescriptor,
  SessionOptionValue
} from '../../../src/shared/native-chat-session-options'
import { mobileNativeChatScopeKey } from './mobile-native-chat-scope-key'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import type { MobileNativeChatSessionOptionPickersProps } from './MobileNativeChatSessionOptionPickers'
import type { MobileNativeChatPermissionPickerState } from './MobileNativeChatPermissionPicker'
import {
  useMobileNativeChatSessionOptions,
  type MobileNativeChatSessionOptionsController
} from './use-mobile-native-chat-session-options'

export function useMobileNativeChatSessionOptionController(args: {
  client?: RpcClient | null
  activeChatStructured: boolean
  activeSessionTabId: string | null
  agent: string | null
  dispatchCommand: (text: string) => Promise<MobileNativeChatSendOutcome>
  hostId: string
  isTabChatView: (tabId: string) => boolean
  isWorking: boolean
  reportedModel: string | null
  modelSwitchCommand?: string
  structured: {
    conversationCommands?: readonly AgentSessionConversationCommand[]
    optionPickerRequest?: { id: string; sequence: number } | null
    optionSnapshot: SessionOptionDescriptor[]
    pendingOptionId: string | null
    setStructuredOption: (id: string, value: SessionOptionValue) => Promise<boolean>
    invokeStructuredOption: (id: string) => Promise<boolean>
    permissionPicker?: MobileNativeChatPermissionPickerState | null
  }
  toggleTabChatView: (tabId: string) => void
  worktreeId: string
}): {
  nativeChatSessionOptions: MobileNativeChatSessionOptionPickersProps | null
  recordCommand: (command: string) => void
} {
  const {
    activeChatStructured,
    activeSessionTabId,
    agent,
    dispatchCommand,
    hostId,
    isTabChatView,
    isWorking,
    reportedModel,
    structured,
    toggleTabChatView,
    worktreeId
  } = args
  const {
    invokeStructuredOption: invokeStructuredAction,
    pendingOptionId: structuredPendingId,
    setStructuredOption,
    optionSnapshot: structuredSnapshot
  } = structured

  const handleAgentPicker = useCallback(() => {
    if (activeSessionTabId && isTabChatView(activeSessionTabId)) {
      toggleTabChatView(activeSessionTabId)
    }
  }, [activeSessionTabId, isTabChatView, toggleTabChatView])

  const discoveredModels = useMobileOmpModelDiscovery({
    client: args.client ?? null,
    hostId,
    worktreeId,
    enabled: !activeChatStructured && agent === 'omp' && activeSessionTabId !== null
  })
  const sessionOptions = useMobileNativeChatSessionOptions({
    discoveredModels,
    modelSwitchCommand: args.modelSwitchCommand,
    agent: activeChatStructured ? null : agent,
    scopeKey: mobileNativeChatScopeKey(hostId, worktreeId, activeSessionTabId),
    reportedModel,
    dispatchCommand,
    onAgentPicker: handleAgentPicker
  })
  const structuredController = useMemo<MobileNativeChatSessionOptionsController | null>(
    () =>
      activeChatStructured && (structuredSnapshot.length > 0 || structured.permissionPicker)
        ? {
            snapshot: structuredSnapshot,
            optionPickerRequest: structured.optionPickerRequest,
            conversationCommands: structured.conversationCommands,
            pendingId: structuredPendingId,
            setOption: setStructuredOption,
            invokeAction: invokeStructuredAction,
            recordCommand: () => {}
          }
        : null,
    [
      activeChatStructured,
      invokeStructuredAction,
      setStructuredOption,
      structuredPendingId,
      structuredSnapshot,
      structured.conversationCommands,
      structured.optionPickerRequest,
      structured.permissionPicker
    ]
  )
  const nativeChatSessionOptions = useMemo<MobileNativeChatSessionOptionPickersProps | null>(
    () =>
      activeChatStructured
        ? structuredController
          ? {
              controller: structuredController,
              isWorking,
              ...(structured.permissionPicker
                ? { permissionPicker: structured.permissionPicker }
                : {})
            }
          : null
        : sessionOptions.snapshot.length > 0
          ? { controller: sessionOptions, isWorking }
          : null,
    [
      activeChatStructured,
      isWorking,
      sessionOptions,
      structured.permissionPicker,
      structuredController
    ]
  )

  return { nativeChatSessionOptions, recordCommand: sessionOptions.recordCommand }
}
