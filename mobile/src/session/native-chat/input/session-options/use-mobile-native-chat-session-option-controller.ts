import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import { useMobileNativeChatModelDiscovery } from './use-mobile-native-chat-model-discovery'
import { writeMobileNativeChatSessionOptions } from './mobile-native-chat-session-option-persistence'
import { getAgentSessionOptionCatalog } from '../../../../../../src/shared/agent-session/options/agent-session-option-catalog'
import type { AgentSessionOptionCatalog } from '../../../../../../src/shared/agent-session/options/catalog-providers/agent-session-option-catalog-types'
import type { AgentSessionConversationCommand } from '../../../../../../src/shared/agent-session/conversation-context/agent-session-conversation-command'
import { useCallback, useMemo } from 'react'
import type {
  NativeChatSessionOptionSettingsMutation,
  SessionOptionDescriptor,
  SessionOptionValue,
  SessionOptionsSurface
} from '../../../../../../src/shared/native-chat/input/native-chat-session-options'
import { mobileNativeChatScopeKey } from '../../conversation/mobile-native-chat-scope-key'
import type { MobileNativeChatSendOutcome } from '../../composer/delivery/mobile-native-chat-send'
import type { MobileNativeChatSessionOptionPickersProps } from './MobileNativeChatSessionOptionPickers'
import {
  useMobileNativeChatSessionOptions,
  type MobileNativeChatSessionOptionsController
} from './use-mobile-native-chat-session-options'

function isAuthoritativeListing(catalog: AgentSessionOptionCatalog | null): boolean {
  return catalog?.listModels !== undefined && catalog.discoveredModelsAreAuthoritative === true
}

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
    optionSurface?: SessionOptionsSurface
    conversationCommands?: readonly AgentSessionConversationCommand[]
    compactInstructions?: boolean
    optionPickerRequest?: { id: string; sequence: number } | null
    snapshot: SessionOptionDescriptor[]
    pendingId: string | null
    appliesOnAttach?: boolean
    heldPick?: boolean
    setOption: (id: string, value: SessionOptionValue) => Promise<boolean>
    invokeAction: (id: string) => Promise<boolean>
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
    invokeAction: invokeStructuredAction,
    pendingId: structuredPendingId,
    setOption: setStructuredOption,
    snapshot: structuredSnapshot
  } = structured

  const handleAgentPicker = useCallback(() => {
    if (activeSessionTabId && isTabChatView(activeSessionTabId)) {
      toggleTabChatView(activeSessionTabId)
    }
  }, [activeSessionTabId, isTabChatView, toggleTabChatView])

  const client = args.client ?? null
  const chatVisible = activeSessionTabId !== null && isTabChatView(activeSessionTabId)
  const discovery = useMobileNativeChatModelDiscovery({
    client,
    agent,
    hostId,
    worktreeId,
    // Claude's probe replaces the alias seed, so the phone must fetch it to name custom routes.
    // Other agents are fetched only when discovery can retire a seeded model.
    // Leaving chat drops the catalog so a return cannot offer the previous probe while refreshing.
    enabled:
      chatVisible &&
      !activeChatStructured &&
      agent !== null &&
      (agent === 'claude' || isAuthoritativeListing(getAgentSessionOptionCatalog(agent)))
  })
  const writeSettings = useCallback(
    (mutation: NativeChatSessionOptionSettingsMutation) => {
      if (client) {
        void writeMobileNativeChatSessionOptions(client, mutation)
      }
    },
    [client]
  )
  const sessionOptions = useMobileNativeChatSessionOptions({
    discoveredModels: discovery.models,
    discoveryFailed: discovery.failed,
    chatVisible,
    modelSwitchCommand: args.modelSwitchCommand,
    agent: activeChatStructured ? null : agent,
    scopeKey: mobileNativeChatScopeKey(hostId, worktreeId, activeSessionTabId),
    reportedModel,
    dispatchCommand,
    onAgentPicker: handleAgentPicker,
    writeSettings
  })
  // Kept with nothing to pick (OMP lists no models): the "/" menu reads the chat's commands from it.
  const structuredController = useMemo<MobileNativeChatSessionOptionsController | null>(
    () =>
      activeChatStructured
        ? {
            snapshot: structuredSnapshot,
            optionPickerRequest: structured.optionPickerRequest,
            optionSurface: structured.optionSurface,
            conversationCommands: structured.conversationCommands,
            compactInstructions: structured.compactInstructions,
            pendingId: structuredPendingId,
            appliesOnAttach: structured.appliesOnAttach,
            heldPick: structured.heldPick,
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
      structured.appliesOnAttach,
      structured.heldPick,
      structured.compactInstructions,
      structured.conversationCommands,
      structured.optionPickerRequest,
      structured.optionSurface
    ]
  )
  const nativeChatSessionOptions = useMemo<MobileNativeChatSessionOptionPickersProps | null>(
    () =>
      activeChatStructured
        ? structuredController
          ? { controller: structuredController, isWorking }
          : null
        : sessionOptions.snapshot.length > 0
          ? { controller: sessionOptions, isWorking }
          : null,
    [activeChatStructured, isWorking, sessionOptions, structuredController]
  )

  return { nativeChatSessionOptions, recordCommand: sessionOptions.recordCommand }
}
