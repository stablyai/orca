import { useState } from 'react'
import { Text, View } from 'react-native'
import { ListRow } from '../components/list/ListGroup'
import { MobileBotTextButton } from './MobileBotTextButton'
import { BottomDrawer } from '../components/bottom-drawer/BottomDrawer'
import { MobileSegmentedControl } from '../components/controls/MobileSegmentedControl'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { hostScreenStyles as styles } from '../host-screen/host-screen-styles'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { MobileBotActivityTab } from './MobileBotActivityTab'
import { MobileBotAutomationsTab } from './MobileBotAutomationsTab'
import { MobileBotAvatar } from './MobileBotAvatar'
import { MobileBotSettingsTab } from './MobileBotSettingsTab'
import { botAgentLabel } from './mobile-bot-sheet-copy'
import { sheetStyles } from './mobile-bot-sheet-styles'
import type { BotAccessRequests } from './use-bot-access-requests'
import { useBotUpNext } from './use-bot-up-next'
import { lookAroundSupported } from '../../../src/shared/bots/bot-look-around'
import type { RouteBot } from './use-route-bot'
import type { BotChatTreeActions } from './MobileBotChatTree'
import { usePhoneBotChatTree } from './use-phone-bot-chat-tree'
import { optionStyles } from './mobile-bot-option-styles'

type BotSheetTab = 'activity' | 'automations' | 'settings'

/** The bot's Activity, Automations and Settings, behind ⋯ in its Home Chat. */
export function MobileBotSheet(props: {
  visible: boolean
  onClose: () => void
  routeBot: RouteBot
  client: RpcClient | null
  showToast: (message: string, durationMs?: number) => void
  /** Drafts into the Home Chat, where automations are made; absent while no chat shows. */
  onNewAutomation: (() => void) | null
  /** Access requests, listed above who can ask. */
  accessRequests: BotAccessRequests | null
  /** Puts an Up next request in the Home Chat's message box; null while no chat shows. */
  onStartSuggestion: ((ask: string) => void) | null
  /** The phone's key for the bot's host (`hostBotsKey`). */
  hostKey: string
  /** Opens a chat or a worker's workspace from Activity's Chats. */
  treeActions: BotChatTreeActions
}) {
  const t = useMobileTranslation()
  const [tab, setTab] = useState<BotSheetTab>('activity')
  const upNext = useBotUpNext({
    client: props.client,
    botId: props.routeBot.bot.id,
    upNext: props.routeBot.activity?.upNext,
    showing: props.visible && tab === 'activity',
    showToast: props.showToast,
    onStart: props.onStartSuggestion,
    refresh: props.routeBot.refresh
  })
  const tree = usePhoneBotChatTree({
    client: props.client,
    botId: props.routeBot.bot.id,
    showing: props.visible && tab === 'activity',
    reads: props.routeBot.reads
  })
  const tabs = [
    { value: 'activity', label: t('bots.sheet.activity', 'Activity') },
    { value: 'automations', label: t('bots.sheet.automations', 'Automations') },
    { value: 'settings', label: t('bots.sheet.settings', 'Settings') }
  ] as const
  const { bot, avatar } = props.routeBot
  return (
    <BottomDrawer visible={props.visible} onClose={props.onClose} scrollResetKey={tab}>
      <View style={optionStyles.filterModalHeader}>
        <View style={sheetStyles.heading}>
          <MobileBotAvatar avatar={avatar} size={32} />
          <View style={optionStyles.filterModalHeading}>
            <Text style={optionStyles.filterModalTitle} numberOfLines={1}>
              {bot.name}
            </Text>
            <Text style={styles.filterModalSubtitle} numberOfLines={1}>
              {botAgentLabel(bot.agent)}
            </Text>
          </View>
        </View>
      </View>
      <MobileSegmentedControl
        segments={tabs}
        selected={tab}
        onSelect={setTab}
        fill
        style={styles.optionSegmented}
        testIDPrefix="bot-sheet-tab-"
      />
      {props.routeBot.activity && props.routeBot.activityError ? (
        <ListRow
          title={t('bots.activity.readFailed', 'Couldn’t load activity.')}
          subtitle={t('bots.activity.lastRead', 'Showing the last activity read.')}
          accessory={
            <MobileBotTextButton
              label={t('bots.activity.retry', 'Retry')}
              disabled={props.routeBot.activityLoading}
              onPress={props.routeBot.refresh}
            />
          }
        />
      ) : null}
      {tab === 'activity' ? (
        <MobileBotActivityTab
          bot={bot}
          hostKey={props.hostKey}
          activity={props.routeBot.activity}
          tree={tree}
          treeActions={props.treeActions}
          upNextActions={upNext}
          loading={props.routeBot.activityLoading}
          error={!!props.routeBot.activityError}
          onRetry={props.routeBot.refresh}
        />
      ) : tab === 'automations' && !props.routeBot.activity ? (
        <MobileBotActivityTab
          bot={bot}
          hostKey={props.hostKey}
          activity={null}
          tree={{ kind: 'none' }}
          treeActions={props.treeActions}
          upNextActions={upNext}
          loading={props.routeBot.activityLoading}
          error={!!props.routeBot.activityError}
          onRetry={props.routeBot.refresh}
        />
      ) : tab === 'automations' ? (
        <MobileBotAutomationsTab
          client={props.client}
          bot={bot}
          rows={props.routeBot.activity?.automations ?? null}
          showToast={props.showToast}
          onNewAutomation={props.onNewAutomation}
        />
      ) : (
        <MobileBotSettingsTab
          routeBot={props.routeBot}
          client={props.client}
          showToast={props.showToast}
          accessRequests={props.accessRequests}
          lookAround={
            lookAroundSupported(bot.agent) ? { onLookNow: upNext.lookNow, busy: upNext.busy } : null
          }
        />
      )}
    </BottomDrawer>
  )
}
