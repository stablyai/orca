import { useLayoutEffect, useState, type ReactNode, type RefObject } from 'react'
import { Animated, Easing, Platform, ScrollView, Text, View } from 'react-native'
import { DetailCardFocusBoundary, commitDetailCardExit } from './detail-card-host'
import { useReducedMotionEnabled } from '../platform/use-reduced-motion'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

/** Layer coordinates: below a trigger by the card's leading and top edges, above it by its trailing and bottom edges. */
export type DetailCardPlacement =
  | { side: 'below'; left: number; top: number }
  | { side: 'above'; right: number; bottom: number }

export type DetailCardAnchor = DetailCardPlacement & { origin: { x: number; y: number } }

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
  layerHeight,
  contentRef,
  boundaryRefs,
  active,
  obscured,
  onSettled,
  title,
  titleTrailing,
  detail,
  children,
  footer
}: {
  anchor: DetailCardAnchor
  target: 0 | 1
  motion: number
  bounds: { left: number; top: number; right: number; bottom: number }
  layerHeight: number
  contentRef: RefObject<View | null>
  boundaryRefs: RefObject<unknown[]>
  active: boolean
  obscured: boolean
  onSettled: (motion: number) => void
  title: string
  titleTrailing?: string
  detail?: string | null
  children?: ReactNode
  footer?: ReactNode
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
  const minLeft = bounds.left + EDGE_INSET
  const maxLeft = bounds.right - EDGE_INSET - width
  let placement: { left: number; top?: number; bottom?: number; maxHeight: number }
  if (anchor.side === 'below') {
    const top = Math.max(anchor.top, bounds.top)
    placement = {
      left: Math.min(Math.max(anchor.left, minLeft), maxLeft),
      top,
      maxHeight: Math.max(0, bounds.bottom - top - EDGE_INSET)
    }
  } else {
    const bottom = Math.min(anchor.bottom, bounds.bottom)
    placement = {
      left: Math.min(Math.max(anchor.right - width, minLeft), maxLeft),
      bottom: layerHeight - bottom,
      maxHeight: Math.max(0, bottom - bounds.top - EDGE_INSET)
    }
  }
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
            ...placement,
            width,
            opacity: progress,
            transform: slide
              ? [
                  {
                    translateY: progress.interpolate({
                      inputRange: [0, 1],
                      outputRange: [anchor.side === 'below' ? SLIDE_FROM : -SLIDE_FROM, 0]
                    })
                  }
                ]
              : []
          }
        ]}
      >
        <ScrollView contentContainerStyle={styles.content} tabIndex={active ? 0 : -1}>
          <View style={styles.titleRow}>
            <Text style={styles.title} selectable>
              {title}
            </Text>
            {titleTrailing ? (
              <Text style={styles.titleTrailing} selectable>
                {titleTrailing}
              </Text>
            ) : null}
          </View>
          {detail ? (
            <Text style={styles.detail} selectable>
              {detail}
            </Text>
          ) : null}
          {children}
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
  titleRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing.md
  },
  title: {
    flexShrink: 1,
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  titleTrailing: {
    color: colors.textMuted,
    fontSize: typography.bodySize,
    fontVariant: ['tabular-nums']
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
