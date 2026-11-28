import { useEffect, useRef, type ReactNode } from 'react'
import { Pressable, StyleSheet, View, type HostInstance } from 'react-native'
import { GestureDetector } from 'react-native-gesture-handler'
import Animated, { useAnimatedStyle } from 'react-native-reanimated'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import {
  SIDEBAR_DOCKED_WIDTH,
  SIDEBAR_PEEK,
  type MobileSessionSidebar
} from './use-mobile-session-sidebar'

// The session's corner in card space: 40 pt on screen at the card's 0.9 scale, near the display's own.
const CARD_RADIUS = 44
const CARD_SHRINK = 0.1
// The panel's content drifts in this far as it's revealed, so it reads as uncovered rather than pushed.
const PANEL_DRIFT = 32
const VEIL_OPACITY = 0.1
// Under Reduce Motion the card stays put and this scrim dims the strip of it still showing.
const REDUCED_SCRIM_OPACITY = 0.3

/**
 * The session as a card over the sidebar: opening slides it left and shrinks it until only its
 * left 80 pt shows; the sidebar lies still beneath. Wide screens dock the sidebar as a column.
 */
export function MobileSessionSidebarStage({
  sidebar,
  panel,
  cardLabel,
  children
}: {
  sidebar: MobileSessionSidebar
  panel: ReactNode
  /** What a screen reader hears for the card while the sidebar is open. */
  cardLabel: string
  children: ReactNode
}) {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const { progress, width, reducedMotion: reduced, docked, shown, open } = sidebar
  const moves = !docked && !reduced
  const cardStyle = useAnimatedStyle(() => {
    const p = progress.value
    if (!moves || p <= 0) {
      return { transform: [], borderRadius: 0 }
    }
    const w = width.value
    const scale = 1 - CARD_SHRINK * Math.min(p, 1)
    const right = w - (w - SIDEBAR_PEEK) * p
    return {
      transform: [{ translateX: right - (w / 2) * (1 + scale) }, { scale }],
      borderRadius: CARD_RADIUS
    }
  }, [progress, width, moves])
  const shadowStyle = useAnimatedStyle(() => {
    const p = progress.value
    const w = width.value
    const scale = 1 - CARD_SHRINK * Math.min(p, 1)
    const right = w - (w - SIDEBAR_PEEK) * p
    return {
      opacity: Math.min(p, 1),
      transform: [{ translateX: right - (w / 2) * (1 + scale) }, { scale }]
    }
  }, [progress, width])
  const veilStyle = useAnimatedStyle(
    () => ({ opacity: VEIL_OPACITY * Math.min(progress.value, 1) }),
    [progress]
  )
  const panelStyle = useAnimatedStyle(() => {
    const p = Math.min(progress.value, 1)
    return reduced ? { opacity: p } : { transform: [{ translateX: (1 - p) * PANEL_DRIFT }] }
  }, [progress, reduced])
  const scrimStyle = useAnimatedStyle(
    () => ({ opacity: REDUCED_SCRIM_OPACITY * Math.min(progress.value, 1) }),
    [progress]
  )

  const aside = open && !docked
  const inertRef = useRef<HostInstance>(null)
  useEffect(() => {
    const node: unknown = inertRef.current
    if (typeof HTMLElement !== 'undefined' && node instanceof HTMLElement) {
      node.inert = aside
    }
  }, [aside])
  // Keyed, so Reduce Motion lifting the panel over the card moves it without remounting the session.
  const panelLayer = shown ? (
    <Animated.View
      key="panel"
      style={[
        docked ? styles.docked : [styles.panel, reduced && styles.panelOver],
        !docked && panelStyle
      ]}
      accessibilityViewIsModal={!docked}
      aria-modal={!docked}
    >
      {panel}
    </Animated.View>
  ) : null
  return (
    <View
      style={[styles.stage, docked && styles.stageDocked]}
      onLayout={(event) => sidebar.onStageLayout(event.nativeEvent.layout.width)}
    >
      {/* Docked, the panel comes first so row-reverse puts it on the right. */}
      {reduced && !docked ? null : panelLayer}
      {shown && moves ? (
        <Animated.View key="shadow" pointerEvents="none" style={[styles.shadow, shadowStyle]} />
      ) : null}
      <Animated.View
        key="card"
        style={[styles.card, shown && moves && styles.cardAside, cardStyle]}
      >
        {/* Live but out of reach while aside: no focus, no screen reader, no touches. */}
        <View ref={inertRef} style={styles.cardContent} aria-hidden={aside || undefined}>
          {children}
        </View>
        {shown && moves ? (
          <Animated.View pointerEvents="none" style={[styles.veil, veilStyle]} />
        ) : null}
      </Animated.View>
      {reduced && shown && !docked ? (
        <>
          <Animated.View key="scrim" pointerEvents="none" style={[styles.scrim, scrimStyle]} />
          {panelLayer}
        </>
      ) : null}
      {aside ? (
        // The strip of card still showing: a tap or a drag brings the session back.
        <GestureDetector gesture={sidebar.cardDrag} touchAction="pan-y">
          <Pressable
            style={styles.cover}
            accessibilityRole="button"
            accessibilityLabel={t('session.sidebar.backTo', 'Back to {{title}}', {
              title: cardLabel
            })}
            onPress={() => {
              if (!sidebar.tapIsDragEnd()) {
                sidebar.close()
              }
            }}
          />
        </GestureDetector>
      ) : null}
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors, scheme) => {
  const dark = scheme === 'dark'
  // The ground under the card: the panel colour dark, the off-white raised colour light.
  const ground = dark ? colors.bgPanel : colors.bgRaised
  return {
    stage: { flex: 1, backgroundColor: ground, overflow: 'hidden' },
    stageDocked: { flexDirection: 'row-reverse' },
    card: { flex: 1, backgroundColor: colors.bgBase },
    cardContent: { flex: 1 },
    cover: { position: 'absolute', top: 0, bottom: 0, left: 0, width: SIDEBAR_PEEK },
    cardAside: { overflow: 'hidden' },
    panel: { position: 'absolute', top: 0, right: 0, bottom: 0, left: SIDEBAR_PEEK },
    panelOver: { backgroundColor: ground },
    docked: {
      width: SIDEBAR_DOCKED_WIDTH,
      backgroundColor: ground,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderLeftColor: colors.borderSubtle
    },
    // A shadow drawn once and faded with the card, never animated itself.
    shadow: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      borderRadius: CARD_RADIUS,
      backgroundColor: colors.bgBase,
      shadowColor: '#000000',
      shadowOpacity: dark ? 0.55 : 0.14,
      shadowRadius: dark ? 48 : 40,
      shadowOffset: { width: 0, height: dark ? 18 : 14 },
      // A faint rim so a black card parts from a near-black ground.
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: dark ? 'rgba(255, 255, 255, 0.09)' : 'rgba(0, 0, 0, 0.06)'
    },
    veil: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: '#000000'
    },
    scrim: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: 0,
      width: SIDEBAR_PEEK,
      backgroundColor: '#000000'
    }
  }
})
