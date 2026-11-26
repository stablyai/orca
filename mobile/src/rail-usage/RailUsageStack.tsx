import { useContext, useState } from 'react'
import { ScrollView, View, useWindowDimensions } from 'react-native'
import type { AccountsSnapshot } from '../accounts/accounts-snapshot'
import { BottomDrawerModalHost } from '../components/bottom-drawer/bottom-drawer-modal-host'
import { MobileEdgeFade } from '../components/list/MobileEdgeFade'
import { useAccountsSnapshot } from '../composer-usage/accounts-snapshot-store'
import { ComposerUsageSheet } from '../composer-usage/ComposerUsageSheet'
import { useResetCountdownNow } from '../composer-usage/use-reset-countdown-now'
import { colors, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useHostClient } from '../transport/connection/host-client-hooks'
import { DUO_STATUS_RING_DIAMETER, duoStatusGlyphMidX } from '../layout/duo-status-row'
import { useReservedRegions } from '../layout/reserved-regions'
import { useSideRailStrip } from '../layout/side-rail'
import type { SideRailStrip } from '../layout/side-rail-strip'
import { listRailUsage, railRingCenter } from './rail-usage-model'
import { RailUsageRing } from './RailUsageRing'
import { RailBandAtStripTopContext } from './RailUsageSpan'
import { railRingStackFit } from './rail-ring-stack-fit'

/** The percent label below a ring hangs this far past its bottom edge. */
const RING_LABEL_OVERHANG = 5
const MIN_RING_GAP = spacing.sm
const CUT_FADE = spacing.md
/**
 * The reported status column reaches this far below the Wi-Fi ring's dots (23pt folded, 26pt
 * unfolded, iOS 27.1 simulator); a stack at the strip's top rises into it, to sit one gap under them.
 */
const STATUS_COLUMN_SLACK = 22

/** The rings in a rail of their own (a tablet's), sized for its larger screen. */
export const STANDALONE_RING_DIAMETER = 60

/** The host's usage rings for the Duo side rail; empty until it reports a provider. */
export function HostRailUsageStack({ hostId }: { hostId: string }): React.JSX.Element | null {
  const { client } = useHostClient(hostId)
  return <RailUsageStack snapshot={useAccountsSnapshot(client)} />
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

/** A scrolling column of usage rings; a tap opens the usage pop-up on that provider. */
export function RailUsageStack({
  snapshot,
  standalone = false
}: {
  snapshot: AccountsSnapshot | null
  /** Centred in its own column rather than on the Duo status glyph's axis. */
  standalone?: boolean
}): React.JSX.Element | null {
  const usages = listRailUsage(snapshot)
  // Ticks at each ring's next label change, like the composer bar, so the two flip together.
  const now = useResetCountdownNow(
    usages.flatMap((usage) => usage.windows.flatMap((entry) => entry.window.resetsAt ?? []))
  )
  const [selected, setSelected] = useState<string | null>(null)
  // Kept after close so the sheet slides out still showing what it showed.
  const [shown, setShown] = useState<string | null>(null)
  const strip = useSideRailStrip()
  const center = useRailRingCenter(strip)
  // The band the rail gives the stack; a chat's composer can leave less than the whole column.
  const [room, setRoom] = useState<number | null>(null)
  const atStripTop = useContext(RailBandAtStripTopContext)
  // A tablet's own rail has the room it needs; only the Duo's column rises and fits.
  const lift = !standalone && atStripTop ? STATUS_COLUMN_SLACK : 0
  const fit = railRingStackFit({
    count: standalone ? 0 : usages.length,
    room,
    ring: DUO_STATUS_RING_DIAMETER,
    overhang: RING_LABEL_OVERHANG,
    gap: COLUMN_GAP,
    minGap: MIN_RING_GAP,
    paddingTop: COLUMN_PADDING_TOP,
    paddingBottom: COLUMN_PADDING_BOTTOM,
    peek: CUT_FADE
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
        style={[styles.scroll, { marginTop: -lift }]}
        onLayout={(event) => setRoom(event.nativeEvent.layout.height)}
      >
        <ScrollView
          style={fit.height === null ? styles.scroll : { flexGrow: 0, height: fit.height }}
          contentContainerStyle={[
            styles.column,
            standalone
              ? styles.centered
              : {
                  paddingLeft: center - DUO_STATUS_RING_DIAMETER / 2,
                  gap: fit.gap,
                  paddingBottom: fit.paddingBottom
                }
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
      <BottomDrawerModalHost>
        <ComposerUsageSheet
          visible={selected !== null}
          onClose={() => setSelected(null)}
          usage={sheetUsage}
          snapshot={snapshot}
          spanSideStrip
        />
      </BottomDrawerModalHost>
    </>
  )
}

const COLUMN_GAP = spacing.md
const COLUMN_PADDING_TOP = spacing.md
const COLUMN_PADDING_BOTTOM = spacing.lg

const styles = themedStyleSheet(() => ({
  scroll: {
    flex: 1
  },
  // Every ring starts at the same inset, so all share the status glyph's axis; the padding is set inline.
  column: {
    alignItems: 'flex-start',
    paddingTop: COLUMN_PADDING_TOP
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
