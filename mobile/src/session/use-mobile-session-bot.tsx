import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BOTS_ITEMS_RUNTIME_CAPABILITY,
  BOTS_MOBILE_RUNTIME_CAPABILITY
} from '../../../src/shared/bot-runtime-capabilities'
import { botItemUidOfPaneKey } from '../../../src/shared/bots/bot-notification-pane-keys'
import type { BotPanelOpen } from '../bots/MobileBotPanel'
import type { ActionSheetAction } from '../components/sheets/ActionSheetModal'
import { MobileBotAvatar } from '../bots/MobileBotAvatar'
import { botHomeChatReset, botSessionStart } from '../bots/bot-sheet-operations'
import { mobileBotRefusalText } from '../bots/mobile-bot-refusal-text'
import { readAgentSessionErrorRefusal } from '../../../src/shared/agent-session/failures/agent-session-write-failure'
import { readBotAgentChoices } from '../bots/new-bot-host-reads'
import type { BotAgent } from '../../../src/shared/bot-types'
import { MobileAgentIcon } from '../components/icons/MobileAgentIcon'
import { botStatusLine } from '../bots/host-bot-row-facts'
import { hostBotsKey } from '../bots/host-bots-read'
import { botAgentLabel, botStatusFromDots } from '../bots/mobile-bot-sheet-copy'
import { useRouteBot } from '../bots/use-route-bot'
import { useNow } from '../hooks/use-now'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { triggerError } from '../platform/haptics/haptics'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'
import { useRouteCapability } from '../worktree/execution-hosts/use-workspace-client'
import { agentDotState, type AgentDotState } from '../worktree/agent-lineage/agent-row-display'
import {
  launchedSelection,
  withLaunchReply,
  withoutUnansweredLaunch
} from './tabs/pending-session-selection'
import type { MobileSessionPanelRouteActionsModel } from './use-mobile-session-panel-route-actions'
import type { MobileNewTabBotActions } from './tabs/MobileNewTabSheet'
import type { MobileSessionItemLink } from './mobile-session-item-target'
import { useSessionRouteRequest } from './use-session-route-request'

/** A bot's home route: its header facts, its sheet, and its new chats from +; `access`, an access
 *  request its push asked to review, opens in the bot's panel. */
export function useMobileSessionBot(
  scope: MobileSessionPanelRouteActionsModel,
  access: MobileSessionItemLink['access'] = null
) {
  const {
    hostId,
    client,
    connState,
    worktreeId,
    isFolderWorkspaceRoute,
    visibleTabs,
    pendingSelectionRef,
    fetchSessionTabs,
    showToast,
    showCreateTabDrawer
  } = scope
  const executionHost = useWorkspaceExecutionHost()
  const botsOnPhone = useRouteCapability(BOTS_MOBILE_RUNTIME_CAPABILITY)
  // Only a folder can be a bot's home, and only on a host that serves bots to phones.
  const routeBot = useRouteBot({
    client,
    connState,
    worktreeId,
    enabled: isFolderWorkspaceRoute && botsOnPhone && hostId !== undefined,
    hostKey: hostBotsKey(hostId ?? '', executionHost)
  })
  // A host that serves items to phones gets the bot panel behind an Items button; an older one keeps
  // today's sheet behind ⋯ and source control in the bar.
  const itemsOnPhone = useRouteCapability(BOTS_ITEMS_RUNTIME_CAPABILITY) && routeBot !== null
  const t = useMobileTranslation()
  const [showBotSheet, setShowBotSheet] = useState(false)
  const [botPanel, setBotPanel] = useState<BotPanelOpen | null>(null)
  // A desktop edit since the last read must not ride back on the sheet's next save.
  const openBotSheet = () => {
    routeBot?.refresh()
    setShowBotSheet(true)
  }
  const refreshRouteBot = routeBot?.refresh
  const openBotPanel = useCallback(
    (open: BotPanelOpen) => {
      refreshRouteBot?.()
      setBotPanel(open)
    },
    [refreshRouteBot]
  )
  // The panel reads the bot's requests as it opens, so the push's request needs no route read.
  if (access && itemsOnPhone) {
    access.reviewed()
    setBotPanel({ access: access.requestId })
  }
  // An item question's push opens its page once the bot is read.
  const paneRequest = useSessionRouteRequest('paneKey')
  const openedPaneRequest = useRef<typeof paneRequest>(null)
  useEffect(() => {
    const itemUid = botItemUidOfPaneKey(paneRequest?.value)
    if (itemUid && itemsOnPhone && openedPaneRequest.current !== paneRequest) {
      openedPaneRequest.current = paneRequest
      openBotPanel({ item: itemUid })
    }
  }, [paneRequest, itemsOnPhone, openBotPanel])
  const now = useNow(60_000, routeBot !== null)

  const botStatus = useMemo(() => {
    if (!routeBot) {
      return null
    }
    // The host list's roll-up when it has drawn this bot.
    const homeDots: AgentDotState[] = visibleTabs.flatMap((tab) =>
      tab.type === 'terminal' && tab.agentStatus && !tab.agentStatus.restoredUnconfirmed
        ? [agentDotState(tab.agentStatus, now)]
        : tab.type === 'agent-session' && tab.chatStatus
          ? [agentDotState(tab.chatStatus, now)]
          : []
    )
    const status =
      routeBot.listStatus ??
      botStatusFromDots(
        homeDots,
        (routeBot.activity?.workers ?? []).map((row) => row.dot),
        routeBot.bot.paused
      )
    return { status, line: botStatusLine(status, routeBot.bot.paused) }
  }, [routeBot, visibleTabs, now])

  // The agents the host can start a side chat on, read as + opens; only the bot's own until then.
  const [agentChoices, setAgentChoices] = useState<readonly BotAgent[] | null>(null)
  const routeBotId = routeBot?.bot.id
  useEffect(() => {
    if (!showCreateTabDrawer || !client || !routeBotId) {
      return
    }
    let live = true
    void readBotAgentChoices(client).then((agents) => {
      if (live) {
        setAgentChoices(agents)
      }
    })
    return () => {
      live = false
    }
  }, [showCreateTabDrawer, client, routeBotId])
  const [confirmingHomeChat, setConfirmingHomeChat] = useState(false)

  // Opens the chat the host made, armed before asking so a tab picked meanwhile wins over it.
  const openBotChat = async (ask: () => Promise<string>) => {
    const lock = `bot-chat:${Date.now().toString(36)}`
    pendingSelectionRef.current = launchedSelection(lock, {}, null)
    try {
      const sessionId = await ask()
      pendingSelectionRef.current = withLaunchReply(pendingSelectionRef.current, lock, {
        sessionId
      })
      void fetchSessionTabs()
    } catch (error) {
      pendingSelectionRef.current = withoutUnansweredLaunch(pendingSelectionRef.current, lock)
      triggerError()
      // A refused chat says why in chat's words; other host errors are codes, not sentences for the owner.
      const refusal = readAgentSessionErrorRefusal(error)
      if (refusal) {
        showToast(mobileBotRefusalText(refusal), 2400)
      } else {
        showToast(t('bots.chatStartFailed', 'Couldn’t start the chat'), 1800)
      }
    }
  }

  const startSideChat = (botId: string, agent: BotAgent | undefined) => {
    if (client) {
      void openBotChat(
        async () =>
          botSessionStart.interpret(
            await botSessionStart.request(client, { botId, ...(agent ? { agent } : {}) })
          ).sessionId
      )
    }
  }

  const startNewHomeChat = (botId: string) => {
    setConfirmingHomeChat(false)
    if (client) {
      void openBotChat(async () => {
        const { sessionId } = botHomeChatReset.interpret(
          await botHomeChatReset.request(client, { botId })
        )
        // The bot's Home Chat is now this one.
        routeBot?.refresh()
        return sessionId
      })
    }
  }

  const botNewTabActions: MobileNewTabBotActions | null = routeBot
    ? {
        homeChat: {
          label: t('bots.newHomeChat.action', 'New Home Chat'),
          status: t('bots.newHomeChat.hint', 'starts fresh'),
          renderIcon: () => <MobileBotAvatar avatar={routeBot.avatar} size={16} />,
          onPress: () => setConfirmingHomeChat(true)
        },
        sideChatsTitle: t('bots.sideChatsWith', 'Side chats with {{name}}', {
          name: routeBot.bot.name
        }),
        // The bot's own agent is the host's default, even one this build can't name.
        sideChats: [
          { agent: routeBot.bot.agent, pick: undefined },
          ...(agentChoices ?? [])
            .filter((agent) => agent !== routeBot.bot.agent)
            .map((agent) => ({ agent, pick: agent }))
        ].map(({ agent, pick }) => ({
          id: agent,
          label: t('bots.newAgentChat', 'New {{agent}} Chat', { agent: botAgentLabel(agent) }),
          renderIcon: () => <MobileAgentIcon agentId={agent} size={16} />,
          onPress: () => startSideChat(routeBot.bot.id, pick)
        }))
      }
    : null

  const botMoreActions: ActionSheetAction[] =
    routeBot && !itemsOnPhone
      ? [
          {
            id: 'bot',
            label: routeBot.bot.name,
            hint: t('bots.sheet.hint', 'Activity, automations and settings'),
            renderIcon: () => <MobileBotAvatar avatar={routeBot.avatar} size={16} />,
            onPress: openBotSheet
          }
        ]
      : []

  return {
    routeBot,
    botStatus,
    showBotSheet,
    setShowBotSheet,
    openBotSheet,
    itemsOnPhone,
    botPanel,
    setBotPanel,
    openBotPanel,
    botMoreActions,
    botNewTabActions,
    confirmingHomeChat,
    setConfirmingHomeChat,
    startNewHomeChat
  }
}
