import { memo, useMemo } from 'react'
import { View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { HomeBotRow } from './bots/home-bot-rows'
import { MobileHomeBotRows } from './bots/MobileHomeBotRow'
import { homeListStyles } from './home-list-styles'
import { MobileHomeSectionHeading } from './MobileHomeSectionHeading'

// As many as Active shows; the Bots tab has the rest.
const BOT_ROWS_SHOWN = 3

/** Feed's first section: the bots that need you, then the most recent; hidden when none can be listed. */
export const MobileHomeBots = memo(function MobileHomeBots(props: {
  rows: readonly HomeBotRow[]
  onOpen: (row: HomeBotRow) => void
  onSeeAll: () => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const shown = useMemo(() => props.rows.slice(0, BOT_ROWS_SHOWN), [props.rows])
  // Only rows that would read the same name their computer; the Bots tab groups by computer.
  const named = useMemo(
    () =>
      new Set(
        shown
          .filter((row) =>
            shown.some((other) => other.title === row.title && other.placeKey !== row.placeKey)
          )
          .map((row) => row.key)
      ),
    [shown]
  )
  if (props.rows.length === 0) {
    return null
  }
  const more = props.rows.length > BOT_ROWS_SHOWN
  return (
    <>
      <MobileHomeSectionHeading
        title={t('bots.section.title', 'Bots')}
        count={props.rows.length}
        aside={more ? t('home.bots.seeAll', 'See all bots') : undefined}
        onAsidePress={more ? props.onSeeAll : undefined}
        first
      />
      <View style={homeListStyles.group}>
        <MobileHomeBotRows rows={shown} grouped nameComputer={named} onOpen={props.onOpen} />
      </View>
    </>
  )
})
