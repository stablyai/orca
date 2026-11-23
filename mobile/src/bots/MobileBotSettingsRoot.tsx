// The bot's Settings list in the desktop's order: its name and picture, then Agent, Schedule, Items,
// Soul and memory, Access and Notifications, then Delete. Each group is one list; a page is one row here.
import { Fragment, type ReactNode } from 'react'
import { View } from 'react-native'
import { BOT_ITEM_DEFAULT_STALE_DAYS } from '../../../src/shared/bots/bot-items'
import {
  BOT_ITEMS_STALE_CHOICES,
  type BotItemsStale,
  type BotNotifications
} from '../../../src/shared/bot-types'
import { mobilePermissionModeCopy } from './mobile-permission-mode-copy'
import { botStartingPermission } from '../../../src/shared/bots/bot-access-reach'
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
import type { ConnectorPage } from './connectors/connector-pages'
import type { MobileBotAvatarSource } from './host-bot-row-facts'
import { botAgentLabel } from './mobile-bot-sheet-copy'
import { MobileBotAvatar } from './MobileBotAvatar'
import { themedStyleSheet } from '../theme/themed-styles'

/** The pages the list opens. */
export type SettingsRootPage =
  | 'identity'
  | 'agent'
  | 'backup-models'
  | 'permissions'
  | 'computer'
  | 'look-around'
  | 'tidy-up'
  | 'stale'
  | 'soul'
  | 'memory'
  | 'who-can-ask'
  | 'tools'
  | 'skills'
  | 'original'

/** A row a feature adds to the list: the group it sits in, in the desktop's order within it. */
export type SettingsSlotRow = {
  key: string
  group: 'identity' | 'schedule' | 'soul-and-memory' | 'access' | 'sharing'
  node: ReactNode
}

/** What a feature adds to Settings: its rows, and the page that replaces the list while one is open. */
export type SettingsFeature = { rows: SettingsSlotRow[]; page: ReactNode }

/** A Settings page to open on from outside Settings: one the list opens, or one of Connectors' pages. */
export type BotSettingsTarget = SettingsRootPage | ConnectorPage

/** The mode new sessions start in, as the desktop shows it; an agent this phone doesn't know keeps its saved one. */
export function botPermissionSetting(bot: SheetBot) {
  const permission = botStartingPermission(bot, null)
  return { fixed: permission.fixed === true, mode: permission.mode ?? bot.permissionMode ?? null }
}

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
  open: (page: SettingsRootPage) => void
  setActive: (active: boolean) => void
  setNotification: (key: keyof BotNotifications, on: boolean) => void
  onDelete: () => void
  /** Above the list, under the page's header. */
  header: ReactNode
  /** The features' rows, each in its group. */
  rows: SettingsSlotRow[]
  /** Whether the host supports bot backup models. */
  takesBackupModels?: boolean
}) {
  const t = useMobileTranslation()
  const { bot } = props
  const agent = botAgentLabel(bot.agent)
  const state = bot.paused
    ? t('bots.settings.paused', 'Paused')
    : t('bots.settings.active', 'Active')
  const permission = botPermissionSetting(bot)
  const permissionCopy = permission.mode
    ? mobilePermissionModeCopy(bot.agent, permission.mode, t)
    : null
  const rowsIn = (group: SettingsSlotRow['group']) =>
    props.rows
      .filter((row) => row.group === group)
      .map((row) => <Fragment key={row.key}>{row.node}</Fragment>)
  const schedule = rowsIn('schedule')
  const sharing = rowsIn('sharing')
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
            onPress={() => props.open('identity')}
            accessibilityLabel={t(
              'bots.settings.editIdentity',
              'Edit {{name}}’s name and picture',
              {
                name: bot.name
              }
            )}
          />
          {rowsIn('identity')}
        </Section>
        <Section title={t('bots.settings.agent', 'Agent')}>
          <DrillRow
            label={t('bots.settings.agentAndModel', 'Agent and model')}
            value={`${agent} · ${bot.launch?.model ?? t('bots.settings.chatDefault', 'your chat default')}`}
            detail
            onPress={() => props.open('agent')}
          />
          {props.takesBackupModels ? (
            <DrillRow
              label={t('bots.settings.backupModels', 'Backup models')}
              value={
                bot.activeBackup
                  ? t('bots.settings.backupModelsSummaryActive', 'Using {{model}}', {
                      model:
                        bot.activeBackup.target.model ??
                        botAgentLabel(bot.activeBackup.target.agent)
                    })
                  : bot.backupModels?.order.length
                    ? t('bots.settings.backupModelsSummaryCount', '{{count}} configured', {
                        count: bot.backupModels.order.length
                      })
                    : t('bots.settings.backupModelsSummaryOff', 'Off')
              }
              onPress={() => props.open('backup-models')}
            />
          ) : null}
          {/* An agent that asks no approvals only ever runs with full access, so there is nothing to pick. */}
          {permission.fixed ? (
            <ListRow
              title={t('bots.settings.permissions', 'Permissions')}
              subtitle={permissionCopy?.description}
              value={permissionCopy?.label}
            />
          ) : (
            <DrillRow
              label={t('bots.settings.permissions', 'Permissions')}
              value={permissionCopy?.label ?? t('bots.settings.sameAsChats', 'Same as chats')}
              onPress={() => props.open('permissions')}
            />
          )}
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
        {schedule.length > 0 ? (
          <Section title={t('bots.settings.schedule', 'Schedule')}>{schedule}</Section>
        ) : null}
        <Section title={t('bots.settings.items', 'Items')}>
          <DrillRow
            label={t('bots.settings.staleTitle', 'Mark items stale after')}
            value={staleLabel(t, bot.itemsStale ?? BOT_ITEM_DEFAULT_STALE_DAYS)}
            onPress={() => props.open('stale')}
          />
        </Section>
        <Section title={t('bots.settings.soulAndMemory', 'Soul and memory')}>
          {rowsIn('soul-and-memory')}
        </Section>
        <Section title={t('bots.settings.access', 'Access')}>{rowsIn('access')}</Section>
        {/* Its own group after Access, as on the desktop. */}
        {sharing.length > 0 ? <Section>{sharing}</Section> : null}
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
