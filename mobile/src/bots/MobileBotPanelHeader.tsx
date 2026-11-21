// The bot panel's head: the bot's name and "agent · computer", the filter (on Items) and the gear for
// settings, then the tabs with Items' Needs you count; and the Items filter sheet.
import { Text, View } from 'react-native'
import { ListFilter, Settings } from '../components/icons/app-icons'
import type { BotItemFilter } from '../../../src/shared/bots/bot-item-groups'
import { MobileSegmentedControl } from '../components/controls/MobileSegmentedControl'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { ActionSheetModal } from '../components/sheets/ActionSheetModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { MobileBotItemStatusIcon } from './items/MobileBotItemStatusIcon'

export type PanelTab = 'items' | 'chats' | 'files'

export function MobileBotPanelHeader(props: {
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
      <SheetHeader
        title={props.name}
        subtitle={props.sub}
        trailingButtons={
          <>
            {props.tab === 'items' ? (
              <NavBarButton
                icon={ListFilter}
                accessibilityLabel={t('bots.items.filter.label', 'Filter items')}
                active={props.filterActive}
                onPress={props.onFilter}
              />
            ) : null}
            <NavBarButton
              icon={Settings}
              accessibilityLabel={t('bots.sheet.settings', 'Settings')}
              onPress={props.onSettings}
            />
          </>
        }
      />
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

/** The desktop's filter, Needs you only; the bot's chats are on the Chats tab. */
export function MobileBotItemsFilterSheet(props: {
  visible: boolean
  onClose: () => void
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

const styles = themedStyleSheet(() => ({
  segmented: { marginBottom: spacing.sm },
  count: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  countText: {
    fontSize: typography.metaSize,
    color: colors.textSecondary,
    fontVariant: ['tabular-nums']
  }
}))
