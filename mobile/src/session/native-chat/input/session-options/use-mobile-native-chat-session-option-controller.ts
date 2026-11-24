import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import { useMobileNativeChatModelDiscovery } from './use-mobile-native-chat-model-discovery'
import { writeMobileNativeChatSessionOptions } from './mobile-native-chat-session-option-persistence'
import { getAgentSessionOptionCatalog } from '../../../../../../src/shared/agent-session/options/agent-session-option-catalog'
import type { AgentSessionOptionCatalog } from '../../../../../../src/shared/agent-session/options/catalog-providers/agent-session-option-catalog-types'
import type { AgentSessionConversationCommand } from '../../../../../../src/shared/agent-session/conversation-context/agent-session-conversation-command'
import { useCallback, useMemo, useState } from 'react'
import type { AgentStatusEntry } from '../../../../../../src/shared/agent-status/contracts/agent-status-types'
import type {
  NativeChatSessionOptionSettingsMutation,
  SessionOptionDescriptor,
  SessionOptionValue,
  SessionOptionsSurface
} from '../../../../../../src/shared/native-chat/input/native-chat-session-options'
import { createNativeChatTurnNotedOptionPicksHook } from '../../../../../../src/shared/native-chat/input/session-options/use-native-chat-turn-noted-option-picks'
import { mobileNativeChatScopeKey } from '../../conversation/mobile-native-chat-scope-key'
import type { MobileNativeChatSendOutcome } from '../../composer/delivery/mobile-native-chat-send'
import type { MobileNativeChatSessionOptionPickersProps } from './MobileNativeChatSessionOptionPickers'
import {
  useMobileNativeChatSessionOptions,
  type MobileNativeChatSessionOptionsController
} from './use-mobile-native-chat-session-options'

const useNativeChatTurnNotedOptionPicks = createNativeChatTurnNotedOptionPicksHook({
  useCallback,
  useMemo,
  useState
})

const isRefusedWrite = (applied: boolean): boolean => !applied

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
  /** The terminal agent's status row: its model, live effort and session, as desktop reads them. */
  reportedStatus?: Pick<AgentStatusEntry, 'model' | 'modelSwitchCommand' | 'providerSession'> | null
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
  onOptionError?: (message: string) => void
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
    reportedStatus,
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
    isWorking,
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
  const sessionOptions = useMobileNativeChatSessionOptions({
    discoveredModels,
    modelSwitchCommand: reportedStatus?.modelSwitchCommand,
    agent: activeChatStructured ? null : agent,
    scopeKey: mobileNativeChatScopeKey(hostId, worktreeId, activeSessionTabId),
    reportedModel: reportedStatus?.model ?? null,
    reportedEffort: reportedStatus?.providerSession?.effort,
    reportingSessionId: reportedStatus?.providerSession?.id,
    isWorking,
    dispatchCommand,
    onAgentPicker: handleAgentPicker,
    writeSettings,
    onOptionError: args.onOptionError
  })
  const noted = useNativeChatTurnNotedOptionPicks({
    scope: activeChatStructured
      ? mobileNativeChatScopeKey(hostId, worktreeId, activeSessionTabId)
      : null,
    isWorking,
    snapshot: structuredSnapshot,
    setOption: setStructuredOption,
    refused: isRefusedWrite
  })
  // Kept with nothing to pick (OMP lists no models): the "/" menu reads the chat's commands from it.
  const structuredController = useMemo<MobileNativeChatSessionOptionsController | null>(
    () =>
      activeChatStructured
        ? {
            snapshot: noted.snapshot,
            optionPickerRequest: structured.optionPickerRequest,
            optionSurface: structured.optionSurface,
            conversationCommands: structured.conversationCommands,
            compactInstructions: structured.compactInstructions,
            pendingId: structuredPendingId,
            appliesOnAttach: structured.appliesOnAttach,
            heldPick: structured.heldPick,
            setOption: noted.setOption,
            invokeAction: invokeStructuredAction,
            recordCommand: () => {}
          }
        : null,
    [
      activeChatStructured,
      invokeStructuredAction,
      noted.setOption,
      noted.snapshot,
      structuredPendingId,
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
          ? { controller: structuredController }
          : null
        : sessionOptions.snapshot.length > 0
          ? { controller: sessionOptions }
          : null,
    [activeChatStructured, sessionOptions, structuredController]
  )

  return { nativeChatSessionOptions, recordCommand: sessionOptions.recordCommand }
}
