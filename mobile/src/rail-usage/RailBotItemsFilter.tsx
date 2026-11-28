import { ScrollView, View } from 'react-native'
import { mobileBotAvatarSource } from '../bots/host-bot-row-facts'
import { MobileBotAvatar } from '../bots/MobileBotAvatar'
import { MobileSwitch } from '../components/controls/MobileSwitch'
import { ListGroup, ListRow, SectionHeader } from '../components/list/ListGroup'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { spacing } from '../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
import type { RailBotTarget } from './rail-bot-targets'

/** Filter page inside the rail Items sheet: pick bots and/or limit to Needs you only. */
export function RailBotItemsFilter({
  targets,
  pickedKeys,
  setPickedKeys,
  needsYouOnly,
  setNeedsYouOnly,
  openCount,
  showHostNames,
  onClear,
  onDone
}: {
  targets: readonly RailBotTarget[]
  pickedKeys: readonly string[] | null
  setPickedKeys: (next: readonly string[] | null) => void
  needsYouOnly: boolean
  setNeedsYouOnly: (next: boolean) => void
  openCount: (target: RailBotTarget) => number
  showHostNames: boolean
  onClear: () => void
  onDone: () => void
}): React.JSX.Element {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  return (
    <View style={styles.page}>
      <SheetHeader
        title={t('bots.items.filter.label', 'Filter items')}
        leading={{
          label: t('bots.items.filter.clearAll', 'Clear filters'),
          onPress: onClear
        }}
        trailing={{ label: t('common.done', 'Done'), onPress: onDone }}
      />
      <ScrollView style={styles.root} contentContainerStyle={styles.scrollContent}>
        <SectionHeader title={t('bots.groups.items.filterBot', 'Bot')} first />
        <ListGroup>
          {targets.map((target) => {
            const on = pickedKeys === null || pickedKeys.includes(target.key)
            const open = openCount(target)
            return (
              <ListRow
                key={target.key}
                title={target.bot.name}
                {...(showHostNames ? { subtitle: target.hostName } : {})}
                leading={<MobileBotAvatar avatar={mobileBotAvatarSource(target.bot)} size={26} />}
                {...(open ? { value: String(open) } : {})}
                selected={on}
                accessibilityRole="checkbox"
                onPress={() => {
                  const current = pickedKeys ?? targets.map((entry) => entry.key)
                  const next = on
                    ? current.filter((key) => key !== target.key)
                    : [...current, target.key]
                  setPickedKeys(next.length === 0 || next.length === targets.length ? null : next)
                }}
              />
            )
          })}
        </ListGroup>
        <View style={styles.filterGap} />
        <ListGroup>
          <ListRow
            title={t('bots.items.filter.needsYou', 'Needs you only')}
            accessory={
              <MobileSwitch
                value={needsYouOnly}
                onValueChange={setNeedsYouOnly}
                accessibilityLabel={t('bots.items.filter.needsYou', 'Needs you only')}
              />
            }
          />
        </ListGroup>
      </ScrollView>
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  root: { flex: 1 },
  page: { flex: 1, backgroundColor: colors.sheetSurface },
  scrollContent: { paddingBottom: spacing.lg },
  filterGap: { height: spacing.lg }
}))
