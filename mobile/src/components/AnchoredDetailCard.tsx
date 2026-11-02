import { useLayoutEffect, useState, type RefObject } from 'react'
import {
  Animated,
  Easing,
  Platform,
  ScrollView,
  Text,
  View,
  type LayoutRectangle
} from 'react-native'
import { DetailCardFocusBoundary, commitDetailCardExit } from './detail-card-host'
import { useReducedMotionEnabled } from '../platform/use-reduced-motion'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

export type DetailCardAnchor = {
  trigger: LayoutRectangle
  top: number
  origin: { x: number; y: number }
}

const CARD_WIDTH = 256
const EDGE_INSET = spacing.sm
const TRANSITION_MS = 150
const SLIDE_FROM = -6

/** Only the current motion may release the retained exit presentation. */
export function AnchoredDetailCard({
  anchor,
  target,
  motion,
  bounds,
  contentRef,
  boundaryRefs,
  active,
  obscured,
  onSettled,
  title,
  detail,
  footer
}: {
  anchor: DetailCardAnchor
  target: 0 | 1
  motion: number
  bounds: { left: number; top: number; right: number; bottom: number }
  contentRef: RefObject<View | null>
  boundaryRefs: RefObject<unknown[]>
  active: boolean
  obscured: boolean
  onSettled: (motion: number) => void
  title: string
  detail?: string | null
  footer?: React.ReactNode
}): React.JSX.Element {
  useMobileColorScheme()
  // Unknown counts as reduced, so the card never slides before the setting is read.
  const slide = useReducedMotionEnabled() === false
  const [progress] = useState(() => new Animated.Value(0))
  useLayoutEffect(() => {
    let disposed = false
    progress.stopAnimation((value) => {
      if (disposed) {
        return
      }
      if (target === 0 && value === 0) {
        onSettled(motion)
        return
      }
      Animated.timing(progress, {
        toValue: target,
        duration: TRANSITION_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: Platform.OS !== 'web'
      }).start(({ finished }) => {
        if (!disposed && finished && target === 0) {
          commitDetailCardExit(() => onSettled(motion))
        }
      })
    })
    return () => {
      disposed = true
      progress.stopAnimation()
    }
  }, [motion, target, progress, onSettled])

  const width = Math.max(0, Math.min(CARD_WIDTH, bounds.right - bounds.left - EDGE_INSET * 2))
  const left = Math.min(
    Math.max(anchor.trigger.x, bounds.left + EDGE_INSET),
    bounds.right - EDGE_INSET - width
  )
  const top = Math.max(anchor.top, bounds.top)
  const maxHeight = Math.max(0, bounds.bottom - top - EDGE_INSET)
  return (
    <>
      <DetailCardFocusBoundary refs={boundaryRefs} index={2} active={active} />
      <Animated.View
        ref={contentRef}
        tabIndex={-1}
        role="dialog"
        accessibilityLabel={title}
        aria-hidden={!active}
        accessibilityElementsHidden={!active}
        importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}
        pointerEvents={active ? 'auto' : 'none'}
        style={[
          styles.card,
          {
            display: obscured ? 'none' : 'flex',
            left,
            top,
            width,
            maxHeight,
            opacity: progress,
            transform: slide
              ? [
                  {
                    translateY: progress.interpolate({
                      inputRange: [0, 1],
                      outputRange: [SLIDE_FROM, 0]
                    })
                  }
                ]
              : []
          }
        ]}
      >
        <ScrollView contentContainerStyle={styles.content} tabIndex={active ? 0 : -1}>
          <Text style={styles.title} selectable>
            {title}
          </Text>
          {detail ? (
            <Text style={styles.detail} selectable>
              {detail}
            </Text>
          ) : null}
          {footer ? <View style={styles.footer}>{footer}</View> : null}
        </ScrollView>
      </Animated.View>
      <DetailCardFocusBoundary refs={boundaryRefs} index={3} active={active} />
    </>
  )
}

const styles = themedStyleSheet(() => ({
  card: {
    position: 'absolute',
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.surface,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8
  },
  content: { padding: spacing.md },
  title: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  detail: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    marginTop: spacing.xs
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm
  }
}))
