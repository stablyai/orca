import { useCallback, useState } from 'react'
import { Pressable, View, type LayoutChangeEvent, type ViewStyle } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { PanelRightClose, PanelRightOpen } from 'lucide-react-native'
import type { AccountsSnapshot } from '../accounts/accounts-snapshot'
import { useAccountsSnapshot } from '../composer-usage/accounts-snapshot-store'
import { composerInputStylesSheet } from '../components/composer-input/composer-input-styles'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useReservedRegions } from '../layout/reserved-regions'
import { useResponsiveLayout } from '../layout/responsive-layout'
import { useSideRailStrip } from '../layout/side-rail'
import { spacing } from '../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
import { useMobileColors } from '../theme/use-mobile-color-scheme'
import { useHostClient } from '../transport/connection/host-client-hooks'
import { listRailUsage } from './rail-usage-model'
import { RailUsageStack, STANDALONE_RING_DIAMETER } from './RailUsageStack'
import {
  setTabletUsageRailExpanded,
  useTabletUsageRailExpanded
} from './tablet-usage-rail-preference'

// Room for a ring and the percent label that overhangs its sides.
const EXPANDED_WIDTH = STANDALONE_RING_DIAMETER + spacing.md * 2
const COLLAPSED_WIDTH = 44

export type TabletUsageRailState = {
  snapshot: AccountsSnapshot | null
  expanded: boolean
  /** 0 while the rail is hidden. */
  width: number
  /** The page's top edge, which the rail starts level with. */
  top: number
  /** Keeps the page clear of the rail. */
  pageStyle: ViewStyle | null
  onPageLayout: (event: LayoutChangeEvent) => void
}

/**
 * The rail beside a shell page on a wide window with no Duo status column, like an iPad's: hidden on
 * phones, narrow splits and the Duo, and while the host reports no usage.
 */
export function useTabletUsageRail(
  hostId: string,
  onShellLayout: (event: LayoutChangeEvent) => void,
  allowed: boolean
): TabletUsageRailState {
  const { isWideLayout } = useResponsiveLayout()
  const strip = useSideRailStrip()
  const { hasFoldDivision } = useReservedRegions()
  const room = allowed && isWideLayout && strip === null && hasFoldDivision !== true
  const { client } = useHostClient(hostId)
  const snapshot = useAccountsSnapshot(room ? client : null)
  const expanded = useTabletUsageRailExpanded()
  const [top, setTop] = useState(0)
  const onPageLayout = useCallback(
    (event: LayoutChangeEvent) => {
      setTop(event.nativeEvent.layout.y)
      onShellLayout(event)
    },
    [onShellLayout]
  )
  const width =
    room && listRailUsage(snapshot).length > 0 ? (expanded ? EXPANDED_WIDTH : COLLAPSED_WIDTH) : 0
  return {
    snapshot,
    expanded,
    width,
    top,
    pageStyle: width > 0 ? { marginRight: width } : null,
    onPageLayout
  }
}

/** The Duo rail's usage rings in a right-hand column beside the page, folded to its toggle on request. */
export function TabletUsageRail({
  rail
}: {
  rail: TabletUsageRailState
}): React.JSX.Element | null {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const composerInputStyles = useThemedStyles(composerInputStylesSheet)
  const t = useMobileTranslation()
  const insets = useSafeAreaInsets()
  if (rail.width === 0) {
    return null
  }
  const Icon = rail.expanded ? PanelRightClose : PanelRightOpen
  return (
    <View
      style={[
        styles.rail,
        {
          top: rail.top,
          width: rail.width,
          paddingTop: Math.max(0, insets.top - rail.top) + spacing.sm,
          paddingBottom: insets.bottom
        }
      ]}
      testID="tablet-usage-rail"
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          rail.expanded
            ? t('tabletUsageRail.collapse', 'Hide usage rail')
            : t('tabletUsageRail.expand', 'Show usage rail')
        }
        accessibilityState={{ expanded: rail.expanded }}
        hitSlop={6}
        onPress={() => setTabletUsageRailExpanded(!rail.expanded)}
        style={({ pressed }) => [
          composerInputStyles.ghostButton,
          pressed && composerInputStyles.pressed
        ]}
        testID="tablet-usage-rail-toggle"
      >
        <Icon size={18} color={colors.textSecondary} strokeWidth={2} />
      </Pressable>
      {rail.expanded ? <RailUsageStack snapshot={rail.snapshot} standalone /> : null}
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  rail: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    alignItems: 'center',
    borderLeftWidth: 1,
    borderLeftColor: colors.borderSubtle,
    backgroundColor: colors.bgBase
  }
}))
