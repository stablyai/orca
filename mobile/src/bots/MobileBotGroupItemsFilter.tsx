// A group's Items filter, as a page in its drawer: which bots, which room (or all their work), and
// Needs you only, as the desktop's group filter offers them.
import { ScrollView, View } from 'react-native'
import { ListGroup, ListRow, SectionHeader } from '../components/list/ListGroup'
import { MobileSwitch } from '../components/controls/MobileSwitch'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { mobileBotAvatarSource } from './host-bot-row-facts'
import { MobileBotAvatar } from './MobileBotAvatar'
import type { MobileBotGroupItemsRead } from './use-mobile-bot-group-items'

export function MobileBotGroupItemsFilter({
  read,
  onDone
}: {
  read: MobileBotGroupItemsRead
  onDone: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { members, botIds, setBotIds, needsYouOnly, setNeedsYouOnly, clearFilter } = read
  return (
    <View style={styles.page}>
      <SheetHeader
        title={t('bots.items.filter.label', 'Filter items')}
        leading={{
          label: t('bots.items.filter.clearAll', 'Clear filters'),
          onPress: clearFilter
        }}
        trailing={{ label: t('common.done', 'Done'), onPress: onDone }}
      />
      <ScrollView style={styles.root} contentContainerStyle={styles.scrollContent}>
        <SectionHeader title={t('bots.groups.items.filterBot', 'Bot')} first />
        <ListGroup>
          {members.map((bot) => {
            const on = botIds === null || botIds.includes(bot.id)
            const open = read.openCount(bot)
            return (
              <ListRow
                key={bot.id}
                title={bot.name}
                leading={<MobileBotAvatar avatar={mobileBotAvatarSource(bot)} size={26} />}
                {...(open ? { value: String(open) } : {})}
                selected={on}
                accessibilityRole="checkbox"
                onPress={() => {
                  const current = botIds ?? members.map((member) => member.id)
                  const next = on ? current.filter((id) => id !== bot.id) : [...current, bot.id]
                  // Every bot, or none, is the same list: all of them.
                  setBotIds(next.length === 0 || next.length === members.length ? null : next)
                }}
              />
            )
          })}
        </ListGroup>
        <View style={styles.gap} />
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

const styles = themedStyleSheet(() => ({
  root: { flex: 1 },
  page: { flex: 1, backgroundColor: colors.sheetSurface },
  scrollContent: { paddingBottom: spacing.lg },
  gap: { height: spacing.lg }
}))
