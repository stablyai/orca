// The bot panel's head: the Needs you only toggle (on Items), the bot's name and "agent · computer",
// the gear for settings, then the tabs with Items' Needs you count.
import { Text, View } from 'react-native'
import { ListFilter, Settings } from 'lucide-react-native'
import { MobileSegmentedControl } from '../components/controls/MobileSegmentedControl'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
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
  /** Items show only what needs you. */
  needsYouOnly: boolean
  onNeedsYouOnly: () => void
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
        leadingButton={
          props.tab === 'items' ? (
            <NavBarButton
              icon={ListFilter}
              accessibilityLabel={t('bots.items.filter.needsYou', 'Needs you only')}
              active={props.needsYouOnly}
              onPress={props.onNeedsYouOnly}
            />
          ) : undefined
        }
        trailingButtons={
          <NavBarButton
            icon={Settings}
            accessibilityLabel={t('bots.sheet.settings', 'Settings')}
            onPress={props.onSettings}
          />
        }
      />
      <MobileSegmentedControl
        segments={segments}
        selected={props.tab}
        onSelect={props.onTab}
        scrollWhenCrowded
        onSheet
        tabs
        style={styles.segmented}
        testIDPrefix="bot-panel-tab-"
      />
    </>
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
