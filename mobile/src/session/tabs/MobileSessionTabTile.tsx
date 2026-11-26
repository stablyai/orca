import type { ReactNode } from 'react'
import { View } from 'react-native'
import { Bell } from 'lucide-react-native'
import { AgentStateDot } from '../../agents/presentation/AgentStateDot'
import { colors, radii } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import type { MobileSessionTabSummary } from './mobile-session-tab-rows'

const TILE_SIZE = 34
const TILE_DOT_RING = 2

export function MobileSessionTabTile({
  mark,
  badge,
  unreadBell
}: {
  mark: ReactNode
  badge: MobileSessionTabSummary['dotState']
  unreadBell: boolean
}) {
  const dot = badge && badge !== 'idle' ? badge : undefined
  return (
    <View style={styles.tile}>
      {mark}
      {unreadBell || dot ? (
        <View style={styles.tileBadge}>
          {unreadBell ? (
            <Bell size={10} color={colors.statusAmber} fill={colors.statusAmber} />
          ) : dot ? (
            <AgentStateDot state={dot} decorative />
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  tile: {
    width: TILE_SIZE,
    height: TILE_SIZE,
    borderRadius: radii.tile,
    backgroundColor: colors.translucentFill,
    alignItems: 'center',
    justifyContent: 'center'
  },
  // The state dot on the tile's corner, ringed in the group's colour.
  tileBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    padding: TILE_DOT_RING,
    borderRadius: radii.pill,
    backgroundColor: colors.sheetGroup
  }
}))
