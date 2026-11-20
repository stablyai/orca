import { useCallback, useMemo, useState } from 'react'
import {
  BOTS_ITEMS_RUNTIME_CAPABILITY,
  BOTS_MOBILE_RUNTIME_CAPABILITY
} from '../../../src/shared/bot-runtime-capabilities'
import type { BotPanelOpen } from '../bots/MobileBotPanel'
import type { ActionSheetAction } from '../components/sheets/ActionSheetModal'
import { MobileBotAvatar } from '../bots/MobileBotAvatar'
import { botSessionStart } from '../bots/bot-sheet-operations'
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

/** A bot's home route: its header facts, its sheet, and "New chat with" it from +. */
export function useMobileSessionBot(scope: MobileSessionPanelRouteActionsModel) {
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
    setShowCreateTabDrawer
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

  const startBotChat = async (botId: string) => {
    if (!client) {
      return
    }
    const lock = `bot-chat:${Date.now().toString(36)}`
    // Arm before asking so a tab picked meanwhile wins over the new chat.
    pendingSelectionRef.current = launchedSelection(lock, {}, null)
    try {
      const { sessionId } = botSessionStart.interpret(
        await botSessionStart.request(client, { botId })
      )
      pendingSelectionRef.current = withLaunchReply(pendingSelectionRef.current, lock, {
        sessionId
      })
      void fetchSessionTabs()
    } catch (error) {
      pendingSelectionRef.current = withoutUnansweredLaunch(pendingSelectionRef.current, lock)
      triggerError()
      showToast(
        error instanceof Error
          ? error.message
          : t('bots.chatStartFailed', 'Couldn’t start the chat'),
        1800
      )
    }
  }

  const botNewTabActions: ActionSheetAction[] = routeBot
    ? [
        {
          label: t('bots.newChatWith', 'New chat with {{name}}', { name: routeBot.bot.name }),
          hint: botAgentLabel(routeBot.bot.agent),
          renderIcon: () => <MobileBotAvatar avatar={routeBot.avatar} size={16} />,
          onPress: () => {
            setShowCreateTabDrawer(false)
            void startBotChat(routeBot.bot.id)
          }
        }
      ]
    : []

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
    // "New chat with" the bot leads the + menu's agents.
    createTabLeadingAgentActions: botNewTabActions
  }
}
