import type { MobileNativeChatTab } from '../mobile-native-chat-eligibility'
import type { MobileSessionTab } from '../../tabs/mobile-session-tabs'
import type { NativeChatSessionOptionOwner } from '../../../../../src/shared/native-chat/input/native-chat-session-option-cache'
import { readNativeChatSessionOptionSeedBinding } from '../../../../../src/shared/native-chat/input/native-chat-session-option-cache'
import { createNativeChatSessionOptionOwner } from '../../../../../src/shared/native-chat/input/native-chat-session-option-owner'
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
import type { NativeChatSessionOptionDispatchOptions } from '../../../../../src/shared/native-chat/input/native-chat-session-option-dispatch'
import { sendMobileNativeChatModelControl } from './mobile-native-chat-model-control'
import { sameNativeChatSessionOptionBinding } from '../../../../../src/shared/native-chat/input/native-chat-session-option-binding'
import {
  acquireMobileNativeChatTerminalWrite,
  releaseMobileNativeChatTerminalWrite
} from '../mobile-native-chat-terminal-write-lock'
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
  onSendError?: (message: string) => void
  hasSeededLaunchDraft?: () => boolean
  deviceTokenRef?: MutableRefObject<string | null>
  terminalInputEnabled?: boolean
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
  const optionScopeKey = mobileNativeChatScopeKey(hostId, worktreeId, activeSessionTabId)
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
    const binding = { ...bindingFor(selectedTab), agent }
    return createNativeChatSessionOptionOwner(
      optionScopeKey ? readNativeChatSessionOptionSeedBinding(optionScopeKey, binding) : binding,
      () => {
        const tab = args.readSessionTab?.(activeSessionTabId)
        return tab?.type === 'terminal' ? bindingFor(tab) : null
      }
    )
  }, [
    args.readSessionTab,
    activeSessionTabId,
    agent,
    hostId,
    worktreeId,
    optionScopeKey,
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
  const dispatchOptionCommand = useCallback(
    async (command: string, options?: NativeChatSessionOptionDispatchOptions) => {
      if (args.terminalInputEnabled === false) {
        return 'rejected' as const
      }
      const binding = owner?.currentBinding()
      if (owner && !binding) {
        return 'rejected' as const
      }
      const clientId = args.deviceTokenRef?.current
      if (
        client &&
        owner &&
        binding?.terminalHandle &&
        clientId &&
        options?.intent &&
        !args.hasSeededLaunchDraft?.()
      ) {
        if (!acquireMobileNativeChatTerminalWrite(binding.terminalHandle)) {
          return 'rejected' as const
        }
        let result
        try {
          result = await sendMobileNativeChatModelControl({
            client,
            terminal: binding.terminalHandle,
            incarnationId: binding.incarnationId,
            clientId,
            control: {
              agent: binding.agent,
              intent: options.intent,
              observation: {
                detectAgentInteraction: options.detectAgentInteraction,
                expectedChoiceLabel: options.expectedChoiceLabel
              }
            },
            isCurrent: () => {
              const current = owner.currentBinding()
              return (
                current !== null &&
                sameNativeChatSessionOptionBinding(binding, current) &&
                (!args.activeHandleRef || args.activeHandleRef.current === binding.terminalHandle)
              )
            }
          })
        } finally {
          releaseMobileNativeChatTerminalWrite(binding.terminalHandle)
        }
        if (result) {
          return result
        }
      }
      return dispatchCommand(command)
    },
    [
      client,
      owner,
      args.hasSeededLaunchDraft,
      args.activeHandleRef,
      args.deviceTokenRef,
      args.terminalInputEnabled,
      dispatchCommand
    ]
  )
  const sessionOptions = useMobileNativeChatSessionOptions({
    owner,
    isDispatchTargetCurrent: () => {
      if (!owner) {
        return true
      }
      const current = owner.currentBinding()
      return (
        current !== null &&
        (!args.activeHandleRef || args.activeHandleRef.current === current.terminalHandle)
      )
    },
    discoveredModels,
    modelSwitchCommand: args.modelSwitchCommand,
    agent: activeChatStructured ? null : agent,
    scopeKey: optionScopeKey,
    reportedModel,
    dispatchCommand: dispatchOptionCommand,
    onAgentPicker: handleAgentPicker,
    onControlError: args.onSendError,
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
