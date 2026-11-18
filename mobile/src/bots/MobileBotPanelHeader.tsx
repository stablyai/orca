// The bot panel's head: the bot's picture, name and "agent · computer", the filter (on Items) and the
// gear for settings, then the tabs with Items' Needs you count; and the Items filter sheet.
import type { ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ListFilter, Settings } from 'lucide-react-native'
import type { BotItemChatChoice, BotItemFilter } from '../../../src/shared/bots/bot-item-groups'
import { MobileSegmentedControl } from '../components/controls/MobileSegmentedControl'
import { ActionSheetModal } from '../components/sheets/ActionSheetModal'
import { hostScreenStyles } from '../host-screen/host-screen-styles'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, feedback, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { MobileBotAvatar } from './MobileBotAvatar'
import type { MobileBotAvatarSource } from './host-bot-row-facts'
import { MobileBotItemStatusIcon } from './items/MobileBotItemStatusIcon'

export type PanelTab = 'items' | 'chats' | 'files'

export function MobileBotPanelHeader(props: {
  avatar: MobileBotAvatarSource
  name: string
  sub: string
  tab: PanelTab
  onTab: (tab: PanelTab) => void
  needsYou: number
  filterActive: boolean
  onFilter: () => void
  onSettings: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { needsYou } = props
  const segments = [
    {
      value: 'items' as const,
      label: t('bots.items.tab', 'Items'),
      ...(needsYou > 0
        ? {
            accessibilityLabel: t('bots.panel.itemsNeedYou', 'Items, {{count}} need you', {
              count: needsYou
            }),
            trailing: (
              <View style={styles.count}>
                <MobileBotItemStatusIcon status="needs_you" size={6} />
                <Text style={styles.countText}>{needsYou}</Text>
              </View>
            )
          }
        : {})
    },
    { value: 'chats' as const, label: t('bots.panel.chats', 'Chats') },
    { value: 'files' as const, label: t('bots.panel.files', 'Files') }
  ]
  return (
    <>
      <View style={styles.header}>
        <MobileBotAvatar avatar={props.avatar} size={32} />
        <View style={styles.heading}>
          <Text style={styles.title} numberOfLines={1}>
            {props.name}
          </Text>
          <Text style={hostScreenStyles.filterModalSubtitle} numberOfLines={1}>
            {props.sub}
          </Text>
        </View>
        {props.tab === 'items' ? (
          <HeaderButton
            label={t('bots.items.filter.label', 'Filter items')}
            active={props.filterActive}
            onPress={props.onFilter}
          >
            <ListFilter size={19} color={colors.textPrimary} />
          </HeaderButton>
        ) : null}
        <HeaderButton label={t('bots.sheet.settings', 'Settings')} onPress={props.onSettings}>
          <Settings size={19} color={colors.textPrimary} />
        </HeaderButton>
      </View>
      <MobileSegmentedControl
        segments={segments}
        selected={props.tab}
        onSelect={props.onTab}
        scrollWhenCrowded
        tabs
        style={styles.segmented}
        testIDPrefix="bot-panel-tab-"
      />
    </>
  )
}

/** The desktop's two filters: one chat, and Needs you only. */
export function MobileBotItemsFilterSheet(props: {
  visible: boolean
  onClose: () => void
  chats: readonly BotItemChatChoice[]
  filter: BotItemFilter
  onFilter: (filter: BotItemFilter) => void
}) {
  const t = useMobileTranslation()
  const { filter, onFilter } = props
  return (
    <ActionSheetModal
      visible={props.visible}
      title={t('bots.items.filter.label', 'Filter items')}
      onClose={props.onClose}
      actions={[
        {
          id: 'all',
          label: t('bots.items.filter.all', 'All chats'),
          checked: filter.chatId === null,
          onPress: () => onFilter({ ...filter, chatId: null })
        },
        ...props.chats.map((chat) => ({
          id: chat.chatId,
          label:
            chat.kind === 'home'
              ? t('bots.items.homeChat', 'Home Chat')
              : (chat.title ?? t('bots.items.chatFallback', 'Chat')),
          ...(chat.count > 0 ? { status: String(chat.count) } : {}),
          checked: filter.chatId === chat.chatId,
          onPress: () => onFilter({ ...filter, chatId: chat.chatId })
        })),
        {
          id: 'needsYou',
          label: t('bots.items.filter.needsYou', 'Needs you only'),
          renderIcon: () => <MobileBotItemStatusIcon status="needs_you" />,
          checked: filter.needsYou,
          onPress: () => onFilter({ ...filter, needsYou: !filter.needsYou })
        }
      ]}
    />
  )
}

function HeaderButton({
  label,
  active = false,
  onPress,
  children
}: {
  label: string
  active?: boolean
  onPress: () => void
  children: ReactNode
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      hitSlop={6}
      style={({ pressed }) => [
        styles.headerButton,
        active && styles.headerButtonActive,
        pressed && styles.pressed
      ]}
    >
      {children}
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.md
  },
  heading: { flex: 1, minWidth: 0 },
  title: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  headerButton: {
    width: 36,
    height: 36,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center'
  },
  headerButtonActive: { backgroundColor: colors.bgRaised },
  pressed: { opacity: feedback.pressedOpacity },
  segmented: { marginBottom: spacing.sm },
  count: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  countText: {
    fontSize: typography.metaSize,
    color: colors.textSecondary,
    fontVariant: ['tabular-nums']
  }
}))
