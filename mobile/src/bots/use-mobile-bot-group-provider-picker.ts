import { useMemo } from 'react'
import type { BotGroup } from '../../../src/shared/bots/bot-group'
import { folderWorkspaceKey } from '../../../src/shared/workspace/identity/workspace-scope'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileChatProviderPicker } from '../session/native-chat/input/session-options/use-mobile-chat-provider-picker'
import type { MobileNativeChatSessionOptionsController } from '../session/native-chat/input/session-options/use-mobile-native-chat-session-options'
import { useMobileChatProviderCopy } from '../session/native-chat/transcript/MobileNativeChatDivider'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { PhoneBot } from './host-bots-operations'
import type { MobileBotGroupSession } from './MobileBotGroupTurns'

export function useMobileBotGroupProviderPicker({
  client,
  hostId,
  group,
  bots,
  sessions,
  readers,
  recipientId,
  selectProvider
}: {
  client: RpcClient
  hostId: string
  group: BotGroup | undefined
  bots: readonly PhoneBot[]
  sessions: ReadonlyMap<string, MobileBotGroupSession>
  readers: readonly { sessionId: string; agent: string }[]
  recipientId: string | null
  selectProvider: boolean
}) {
  const t = useMobileTranslation()
  const selectedMember = group?.members.find((member) => member.botId === recipientId)
  const selectedBot = selectedMember
    ? bots.find((bot) => bot.id === selectedMember.botId)
    : undefined
  const selectedSession = selectedMember ? sessions.get(selectedMember.sessionId) : undefined
  const providerPicker = useMobileChatProviderPicker(
    client,
    selectProvider && selectedMember && selectedBot ? selectedMember.sessionId : null,
    selectedBot ? folderWorkspaceKey(selectedBot.folderWorkspaceId) : '',
    hostId
  )
  const activeAgent =
    providerPicker?.active ??
    selectedSession?.activeAgent ??
    readers.find((turn) => turn.sessionId === selectedMember?.sessionId)?.agent ??
    selectedBot?.agent ??
    null
  const agentSwitchCopy = useMobileChatProviderCopy(activeAgent, providerPicker?.selection?.agent)
  const groupOptionController = useMemo<MobileNativeChatSessionOptionsController | null>(
    () =>
      selectedSession
        ? {
            snapshot: selectedSession.optionSnapshot,
            optionPickerRequest: selectedSession.optionPickerRequest,
            optionSurface: selectedSession.optionSurface,
            conversationCommands: selectedSession.conversationCommands,
            compactInstructions: selectedSession.compactInstructions,
            pendingId: selectedSession.pendingOptionId,
            appliesOnAttach: selectedSession.appliesOnAttach,
            heldPick: selectedSession.heldPick,
            setOption: selectedSession.setStructuredOption,
            invokeAction: selectedSession.invokeStructuredOption,
            recordCommand: () => {}
          }
        : null,
    [selectedSession]
  )
  const composerSessionOptions = useMemo(
    () =>
      groupOptionController
        ? {
            controller: groupOptionController,
            isWorking: selectedSession?.isWorking ?? false,
            providerPicker,
            activeAgent
          }
        : null,
    [groupOptionController, selectedSession?.isWorking, providerPicker, activeAgent]
  )
  return {
    pending: agentSwitchCopy.pending,
    composerProps: {
      agent: activeAgent,
      sessionOptions: composerSessionOptions,
      placeholder:
        agentSwitchCopy.placeholder ??
        t('bots.groups.composerPlaceholder', 'Message the group, @ to mention a bot')
    }
  }
}
