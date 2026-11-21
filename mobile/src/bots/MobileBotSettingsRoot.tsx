// The bot's Settings list in the desktop's order: its name and picture, then Agent, Schedule, Items,
// Access and Notifications, then Delete. Each group is one list; a page of its own is one row here.
import type { ReactNode } from 'react'
import { View } from 'react-native'
import type { BotTidyUpView } from '../../../src/shared/bots/bot-tidy-up'
import { botTidyUp } from '../../../src/shared/bots/bot-tidy-up'
import { botLookAround } from '../../../src/shared/bots/bot-look-around'
import { BOT_ITEM_DEFAULT_STALE_DAYS } from '../../../src/shared/bots/bot-items'
import {
  BOT_ITEMS_STALE_CHOICES,
  type BotItemsStale,
  type BotNotifications
} from '../../../src/shared/bot-types'
import { agentChatPermissionModeCopy } from '../../../src/shared/agent-session/options/permissions/structured-agent-session-permission-option'
import { ListRow } from '../components/list/ListGroup'
import {
  ChoiceRows,
  DrillRow,
  SwitchRow
} from '../host-screen/workspace-options/workspace-option-rows'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { SettingsNote, SettingsSection as Section } from '../settings/settings-screen-frame'
import type { SheetBot } from './bot-sheet-operations'
import { lookAroundLine, tidyUpLine, whoCanAskLine } from './bot-settings-lines'
import type { MobileBotAvatarSource } from './host-bot-row-facts'
import { botAgentLabel } from './mobile-bot-sheet-copy'
import { MobileBotAvatar } from './MobileBotAvatar'
import { themedStyleSheet } from '../theme/themed-styles'

/** The pages the list opens. */
export type SettingsRootPage =
  | 'identity'
  | 'agent'
  | 'permissions'
  | 'computer'
  | 'look-around'
  | 'tidy-up'
  | 'stale'
  | 'who-can-ask'
  | 'tools'

function staleLabel(t: ReturnType<typeof useMobileTranslation>, stale: BotItemsStale) {
  return stale === 'never'
    ? t('bots.settings.staleNever', 'Never')
    : t('bots.settings.staleDays', '{{days}} days', { days: stale })
}

/** Mark items stale after, as a pick-one page like How often. */
export function MobileBotStalePage(props: {
  stale: BotItemsStale | undefined
  disabled: boolean
  banner: ReactNode
  onBack: { label: string; onPress: () => void }
  onPick: (stale: BotItemsStale) => void
}) {
  const t = useMobileTranslation()
  return (
    <>
      <SheetHeader
        title={t('bots.settings.staleTitle', 'Mark items stale after')}
        onBack={props.onBack}
      />
      {props.banner}
      <ChoiceRows
        choices={BOT_ITEMS_STALE_CHOICES.map((choice) => ({
          id: String(choice),
          label: staleLabel(t, choice)
        }))}
        selected={String(props.stale ?? BOT_ITEM_DEFAULT_STALE_DAYS)}
        disabled={props.disabled}
        onSelect={(id) => {
          const picked = BOT_ITEMS_STALE_CHOICES.find((choice) => String(choice) === id)
          if (picked !== undefined) {
            props.onPick(picked)
          }
        }}
      />
      <SettingsNote>
        {t(
          'bots.settings.staleDetail',
          'No activity for this long. Planned items get 3 times as long.'
        )}
      </SettingsNote>
    </>
  )
}

export function MobileBotSettingsRoot(props: {
  bot: SheetBot
  avatar: MobileBotAvatarSource
  hostName: string
  online: boolean
  /** A save is in flight, or the host is offline: switches wait. */
  locked: boolean
  /** Look around and Memory upkeep, for an agent that can run them; null otherwise. */
  schedule: { lastLookedAt: number | undefined; tidyView: BotTidyUpView | null } | null
  accessRequests: number
  open: (page: SettingsRootPage) => void
  setActive: (active: boolean) => void
  setNotification: (key: keyof BotNotifications, on: boolean) => void
  onDelete: () => void
  /** Above the list, under the page's header. */
  header: ReactNode
  /** Rows under Who can ask in Access, such as Tools. */
  accessRows?: ReactNode
  /** Groups that follow Access, such as Webhooks once the bot has a hook. */
  afterAccess?: ReactNode
}) {
  const t = useMobileTranslation()
  const { bot } = props
  const agent = botAgentLabel(bot.agent)
  const state = bot.paused
    ? t('bots.settings.paused', 'Paused')
    : t('bots.settings.active', 'Active')
  const permission = bot.permissionMode
    ? agentChatPermissionModeCopy(bot.agent, bot.permissionMode).label
    : t('bots.settings.sameAsChats', 'Same as chats')
  const notification = (key: keyof BotNotifications, label: string, detail: string) => (
    <SwitchRow
      label={label}
      detail={detail}
      value={bot.notifications[key]}
      disabled={props.locked}
      onChange={(on) => props.setNotification(key, on)}
    />
  )
  return (
    <>
      {props.header}
      {/* Offline, as on the desktop: everything dims; rows still open their pages to read. */}
      <View style={!props.online && styles.offline}>
        <Section first>
          <ListRow
            leading={<MobileBotAvatar avatar={props.avatar} size={40} />}
            title={bot.name}
            strong
            subtitle={[agent, state, props.hostName].join(' · ')}
            subtitleLines={1}
            navigates
            disabled={!props.online}
            onPress={() => props.open('identity')}
            accessibilityLabel={t(
              'bots.settings.editIdentity',
              'Edit {{name}}’s name and picture',
              {
                name: bot.name
              }
            )}
          />
        </Section>
        <Section title={t('bots.settings.agent', 'Agent')}>
          <DrillRow
            label={t('bots.settings.agentAndModel', 'Agent and model')}
            value={`${agent} · ${bot.launch?.model ?? t('bots.settings.chatDefault', 'your chat default')}`}
            detail
            onPress={() => props.open('agent')}
          />
          <DrillRow
            label={t('bots.settings.permissions', 'Permissions')}
            value={permission}
            onPress={() => props.open('permissions')}
          />
          <DrillRow
            label={t('bots.settings.computer', 'Computer')}
            value={props.hostName}
            onPress={() => props.open('computer')}
          />
          <SwitchRow
            label={t('bots.settings.active', 'Active')}
            detail={t('bots.settings.activeDetail', 'Answers messages and runs automations.')}
            value={!bot.paused}
            disabled={props.locked}
            onChange={props.setActive}
          />
        </Section>
        {props.schedule ? (
          <Section title={t('bots.settings.schedule', 'Schedule')}>
            <DrillRow
              label={t('bots.lookAround.title', 'Look around')}
              value={lookAroundLine(botLookAround(bot), props.schedule.lastLookedAt)}
              detail
              onPress={() => props.open('look-around')}
            />
            <DrillRow
              label={t('bots.tidyUp.title', 'Memory upkeep')}
              value={tidyUpLine(botTidyUp(bot), props.schedule.tidyView?.last?.at)}
              detail
              onPress={() => props.open('tidy-up')}
            />
          </Section>
        ) : null}
        <Section title={t('bots.settings.items', 'Items')}>
          <DrillRow
            label={t('bots.settings.staleTitle', 'Mark items stale after')}
            value={staleLabel(t, bot.itemsStale ?? BOT_ITEM_DEFAULT_STALE_DAYS)}
            onPress={() => props.open('stale')}
          />
        </Section>
        <Section title={t('bots.settings.access', 'Access')}>
          <DrillRow
            label={t('bots.settings.whoCanAsk', 'Who can ask')}
            value={whoCanAskLine(bot.members, props.accessRequests)}
            detail
            onPress={() => props.open('who-can-ask')}
          />
          {props.accessRows}
        </Section>
        {props.afterAccess}
        <Section title={t('bots.settings.notifications', 'Notifications')}>
          {notification(
            'needsPermission',
            t('bots.settings.needsPermission', 'Needs permission'),
            t('bots.settings.needsPermissionDetail', 'When it or a worker needs your approval.')
          )}
          {notification(
            'taskComplete',
            t('bots.settings.taskComplete', 'Task complete'),
            t('bots.settings.taskCompleteDetail', 'A thread, automation or worker finishes.')
          )}
          {notification(
            'couldNotFinish',
            t('bots.settings.couldNotFinish', 'Couldn’t finish'),
            t('bots.settings.couldNotFinishDetail', 'An automation run or worker fails.')
          )}
        </Section>
        <Section>
          <ListRow
            title={t('bots.settings.deleteBot', 'Delete bot…')}
            destructive
            disabled={props.locked}
            onPress={props.onDelete}
            accessibilityRole="button"
          />
        </Section>
      </View>
    </>
  )
}

const styles = themedStyleSheet(() => ({
  offline: { opacity: 0.6 }
}))
