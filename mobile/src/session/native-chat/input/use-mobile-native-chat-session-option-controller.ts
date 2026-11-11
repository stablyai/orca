import type { MobileNativeChatTab } from '../mobile-native-chat-eligibility'
import type { MobileSessionTab } from '../../tabs/mobile-session-tabs'
import type { NativeChatSessionOptionOwner } from '../../../../../src/shared/native-chat/input/native-chat-session-option-cache'
import type { NativeChatSessionOptionBinding } from '../../../../../src/shared/native-chat/input/native-chat-session-option-binding'
import type { MutableRefObject } from 'react'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import { useMobileNativeChatModelDiscovery } from '../../use-mobile-native-chat-model-discovery'
import { writeMobileNativeChatSessionOptions } from './mobile-native-chat-session-option-persistence'
import { getAgentSessionOptionCatalog } from '../../../../../src/shared/agent-session/options/agent-session-option-catalog'
import type { AgentSessionOptionCatalog } from '../../../../../src/shared/agent-session/options/agent-session-option-catalog-types'
import type { AgentSessionConversationCommand } from '../../../../../src/shared/agent-session/agent-session-conversation-command'
import { useCallback, useMemo } from 'react'
import type {
  NativeChatSessionOptionSettingsMutation,
  SessionOptionDescriptor,
  SessionOptionValue,
  SessionOptionsSurface
} from '../../../../../src/shared/native-chat/input/native-chat-session-options'
import { mobileNativeChatScopeKey } from '../mobile-native-chat-scope-key'
import type { MobileNativeChatSendOutcome } from '../mobile-native-chat-send'
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
  activeSessionTab?: MobileNativeChatTab | null
  readSessionTab?: (tabId: string) => MobileSessionTab | null
  activeHandleRef?: MutableRefObject<string | null>
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
  const discoveredModels = useMobileNativeChatModelDiscovery({
    client,
    agent,
    hostId,
    worktreeId,
    // Phone-only limit: only lists that can retire a model are fetched; desktop also enriches seed lists, without per-visit CLI probes.
    enabled:
      !activeChatStructured &&
      activeSessionTabId !== null &&
      agent !== null &&
      isAuthoritativeListing(getAgentSessionOptionCatalog(agent))
  })
  const writeSettings = useCallback(
    (mutation: NativeChatSessionOptionSettingsMutation) => {
      if (client) {
        void writeMobileNativeChatSessionOptions(client, mutation)
      }
    },
    [client]
  )
  const selectedTab = args.activeSessionTab
  const owner = useMemo<NativeChatSessionOptionOwner | undefined>(() => {
    if (!args.readSessionTab || !activeSessionTabId || !agent || selectedTab?.type !== 'terminal') {
      return undefined
    }
    const bindingFor = (tab: MobileNativeChatTab): NativeChatSessionOptionBinding => ({
      agent: tab.agentStatus?.agentType ?? tab.launchAgent ?? agent,
      connectionId: hostId,
      worktreeId,
      terminalHandle: tab.terminal ?? tab.agentStatus?.terminalHandle,
      ptyId: tab.ptyId,
      incarnationId: tab.incarnationId,
      providerSession: tab.agentStatus?.providerSession
    })
    return {
      binding: { ...bindingFor(selectedTab), agent },
      readCurrentBinding: () => {
        const tab = args.readSessionTab?.(activeSessionTabId)
        return tab?.type === 'terminal' ? bindingFor(tab) : null
      }
    }
  }, [
    args.readSessionTab,
    activeSessionTabId,
    agent,
    hostId,
    worktreeId,
    selectedTab?.type,
    selectedTab?.terminal,
    selectedTab?.ptyId,
    selectedTab?.incarnationId,
    selectedTab?.launchAgent,
    selectedTab?.agentStatus?.agentType,
    selectedTab?.agentStatus?.terminalHandle,
    selectedTab?.agentStatus?.providerSession?.key,
    selectedTab?.agentStatus?.providerSession?.id,
    selectedTab?.agentStatus?.providerSession?.transcriptPath
  ])
  const sessionOptions = useMobileNativeChatSessionOptions({
    owner,
    isDispatchTargetCurrent: () =>
      !owner ||
      !args.activeHandleRef ||
      args.activeHandleRef.current === owner.binding.terminalHandle,
    discoveredModels,
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
