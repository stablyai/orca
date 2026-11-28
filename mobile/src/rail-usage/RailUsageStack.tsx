import { useContext, useState } from 'react'
import { ScrollView, View, useWindowDimensions } from 'react-native'
import type { AccountsSnapshot } from '../accounts/accounts-snapshot'
import { BottomDrawerModalHost } from '../components/bottom-drawer/bottom-drawer-modal-host'
import { MobileEdgeFade } from '../components/list/MobileEdgeFade'
import { useAccountsSnapshot } from '../composer-usage/accounts-snapshot-store'
import { ComposerUsageSheet } from '../composer-usage/ComposerUsageSheet'
import { useResetCountdownNow } from '../composer-usage/use-reset-countdown-now'
import { spacing } from '../theme/mobile-theme'
import { useMobileColors } from '../theme/use-mobile-color-scheme'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
import { useHostClient } from '../transport/connection/host-client-hooks'
import {
  DUO_RAIL_CONTROL_SIZE,
  DUO_STATUS_RING_DIAMETER,
  duoStatusGlyphMidX
} from '../layout/duo-status-row'
import { useReservedRegions } from '../layout/reserved-regions'
import { useSideRailStrip } from '../layout/side-rail'
import type { SideRailStrip } from '../layout/side-rail-strip'
import { RailBotItemsSheet } from './RailBotItemsSheet'
import { RailItemsButton } from './RailItemsButton'
import type { RailBotsSource } from './rail-bot-targets'
import { useHostRailBotsSource } from './use-host-rail-bots'
import { listRailUsage, railRingCenter } from './rail-usage-model'
import { RailUsageRing } from './RailUsageRing'
import { RailBandAtStripTopContext } from './RailUsageSpan'
import { railRingStackFit } from './rail-ring-stack-fit'

/** The percent label below a ring hangs this far past its bottom edge (4.25pt, rounded up). */
const RING_LABEL_OVERHANG = 5
/** Extra gap below the solid circular Items button to match the blank descender under ring percent digits. */
const LEADING_VISUAL_SLACK = 3
// Tighter than the resting gap so five rings still fit above one jump arrow in the Duo column.
const MIN_RING_GAP = 6
const CUT_FADE = spacing.md
/**
 * How far the reported status column runs below the Wi-Fi ring's page dots (iOS 27.1 simulator).
 * iOS reports no frame for what the column draws, so these are calibrated, not measured.
 */
const STATUS_COLUMN_SLACK_FOLDED = 23
const STATUS_COLUMN_SLACK_UNFOLDED = 26
/**
 * Kept below the dots on top of the column gap: a Focus icon above the clock pushes the
 * dots ~10pt into the slack, leaving the same gap as between rings.
 */
const FOCUS_ROW_MARGIN = 13

/** The rings in a rail of their own (a tablet's), sized for its larger screen. */
export const STANDALONE_RING_DIAMETER = 60

/** The host's usage rings and Items button for the Duo side rail; empty until it reports a provider. */
export function HostRailUsageStack({ hostId }: { hostId: string }): React.JSX.Element | null {
  const { client } = useHostClient(hostId)
  const snapshot = useAccountsSnapshot(client)
  const bots = useHostRailBotsSource(hostId)
  return <RailUsageStack snapshot={snapshot} bots={bots} />
}

/** The rings' axis: the status glyph's, so each ring sits under it. */
function useRailRingCenter(strip: SideRailStrip | null): number {
  const { width, height } = useWindowDimensions()
  const { occlusions } = useReservedRegions()
  if (strip === null) {
    return 0
  }
  return railRingCenter({
    strip,
    windowWidth: width,
    glyphMidX: duoStatusGlyphMidX({ windowWidth: width, windowHeight: height, strip, occlusions })
  })
}

/** How far a stack at the strip's top rises into the column's slack: one gap plus margin under the dots. */
function useStatusColumnLift(atStripTop: boolean): number {
  const { hasFoldDivision } = useReservedRegions()
  if (!atStripTop) {
    return 0
  }
  const slack = hasFoldDivision ? STATUS_COLUMN_SLACK_UNFOLDED : STATUS_COLUMN_SLACK_FOLDED
  return slack - FOCUS_ROW_MARGIN
}

/** A scrolling column of usage rings with an optional Items button above them; a tap opens that provider. */
export function RailUsageStack({
  snapshot,
  bots = null,
  standalone = false
}: {
  snapshot: AccountsSnapshot | null
  /** Bots reachable from the Items button above the rings; omit to show rings only. */
  bots?: RailBotsSource | null
  /** Centred in its own column rather than on the Duo status glyph's axis. */
  standalone?: boolean
}): React.JSX.Element | null {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const usages = listRailUsage(snapshot)
  // Ticks at each ring's next label change, like the composer bar, so the two flip together.
  const now = useResetCountdownNow(
    usages.flatMap((usage) => usage.windows.flatMap((entry) => entry.window.resetsAt ?? []))
  )
  const [selected, setSelected] = useState<string | null>(null)
  // Kept after close so the sheet slides out still showing what it showed.
  const [shown, setShown] = useState<string | null>(null)
  const [itemsOpen, setItemsOpen] = useState(false)
  const strip = useSideRailStrip()
  const center = useRailRingCenter(strip)
  // The band the rail gives the stack; a chat's composer can leave less than the whole column.
  const [room, setRoom] = useState<number | null>(null)
  const atStripTop = useContext(RailBandAtStripTopContext)
  // A tablet's own rail has the room it needs; only the Duo's column rises and fits.
  const lift = useStatusColumnLift(atStripTop && !standalone)
  const hasItems = bots !== null
  const fit = railRingStackFit({
    count: standalone ? 0 : usages.length,
    room,
    ring: DUO_STATUS_RING_DIAMETER,
    overhang: RING_LABEL_OVERHANG,
    gap: COLUMN_GAP,
    minGap: MIN_RING_GAP,
    paddingTop: COLUMN_PADDING_TOP,
    paddingBottom: COLUMN_PADDING_BOTTOM,
    peek: CUT_FADE,
    // Under the status glyph the top gap stays put. Below Back it tightens with the rings.
    tightenTop: !standalone && !atStripTop,
    leadingHeight: !standalone && hasItems ? DUO_STATUS_RING_DIAMETER + LEADING_VISUAL_SLACK : 0
  })
  if (usages.length === 0 || (strip === null && !standalone)) {
    return null
  }
  const sheetUsage = usages.find((usage) => usage.provider === shown) ?? usages[0]
  const open = (provider: string): void => {
    setShown(provider)
    setSelected(provider)
  }
  return (
    <>
      <View
        style={[styles.scroll, standalone && styles.standaloneRoot, { marginTop: -lift }]}
        onLayout={(event) => setRoom(event.nativeEvent.layout.height)}
      >
        {bots ? (
          <View
            style={[
              styles.leading,
              standalone
                ? styles.leadingStandalone
                : {
                    paddingLeft: center - DUO_STATUS_RING_DIAMETER / 2,
                    paddingTop: COLUMN_PADDING_TOP,
                    paddingBottom: fit.clearGap + LEADING_VISUAL_SLACK
                  }
            ]}
          >
            <RailItemsButton
              size={standalone ? DUO_RAIL_CONTROL_SIZE : DUO_STATUS_RING_DIAMETER}
              needsYou={bots.needsYou}
              active={itemsOpen}
              onPress={() => setItemsOpen(true)}
            />
          </View>
        ) : null}
        <View style={styles.ringsWrap}>
          <ScrollView
            style={fit.height === null ? styles.scroll : { flexGrow: 0, height: fit.height }}
            contentContainerStyle={[
              styles.column,
              standalone
                ? styles.centered
                : {
                    paddingLeft: center - DUO_STATUS_RING_DIAMETER / 2,
                    paddingTop: fit.paddingTop,
                    gap: fit.gap,
                    paddingBottom: fit.paddingBottom
                  },
              hasItems && styles.columnAfterLeading
            ]}
            showsVerticalScrollIndicator={false}
            // Shown in part, the stack rests on whole rings.
            snapToInterval={fit.height === null ? undefined : fit.pitch}
            decelerationRate={fit.height === null ? undefined : 'fast'}
            testID="rail-usage-stack"
          >
            {usages.map((usage) => (
              <RailUsageRing
                key={usage.provider}
                usage={usage}
                now={now}
                diameter={standalone ? STANDALONE_RING_DIAMETER : undefined}
                onPress={() => open(usage.provider)}
              />
            ))}
          </ScrollView>
          {fit.height === null ? null : (
            <View style={[styles.cut, { top: fit.height - CUT_FADE }]} pointerEvents="none">
              <MobileEdgeFade edge="bottom" size={CUT_FADE} color={colors.bgBase} />
            </View>
          )}
        </View>
      </View>
      <BottomDrawerModalHost>
        <ComposerUsageSheet
          visible={selected !== null}
          onClose={() => setSelected(null)}
          usage={sheetUsage}
          snapshot={snapshot}
          spanSideStrip
        />
      </BottomDrawerModalHost>
      {bots ? (
        <RailBotItemsSheet visible={itemsOpen} onClose={() => setItemsOpen(false)} bots={bots} />
      ) : null}
    </>
  )
}

const COLUMN_GAP = spacing.md
const COLUMN_PADDING_TOP = spacing.md
const COLUMN_PADDING_BOTTOM = spacing.lg

const stylesSheet = themedStyleSheet(() => ({
  scroll: {
    flex: 1
  },
  standaloneRoot: {
    alignSelf: 'stretch'
  },
  leading: {
    alignItems: 'flex-start'
  },
  leadingStandalone: {
    alignItems: 'center',
    paddingTop: COLUMN_PADDING_TOP,
    paddingBottom: COLUMN_GAP
  },
  ringsWrap: {
    flex: 1
  },
  // Every ring starts at the same inset, so all share the status glyph's axis; the padding is set inline.
  column: {
    alignItems: 'flex-start',
    paddingTop: COLUMN_PADDING_TOP
  },
  columnAfterLeading: {
    paddingTop: 0
  },
  centered: {
    alignItems: 'center',
    gap: spacing.lg,
    paddingBottom: COLUMN_PADDING_BOTTOM
  },
  cut: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: CUT_FADE
  }
}))
