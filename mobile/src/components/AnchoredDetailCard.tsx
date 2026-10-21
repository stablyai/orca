import { useLayoutEffect, useState, type RefObject } from 'react'
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutRectangle
} from 'react-native'
import { commitDetailCardExit } from './detail-card-host'
import { useReducedMotionEnabled } from '../platform/use-reduced-motion'
import { useBackClaim } from '../navigation/use-back-claim'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

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
  trigger,
  target,
  motion,
  bounds,
  viewport,
  contentRef,
  onDismiss,
  onSettled,
  title,
  detail,
  footer
}: {
  anchor: DetailCardAnchor
  trigger: LayoutRectangle
  target: 0 | 1
  motion: number
  bounds: { left: number; top: number; right: number; bottom: number }
  viewport: LayoutRectangle
  contentRef: RefObject<View | null>
  onDismiss: () => void
  onSettled: (motion: number) => void
  title: string
  detail?: string | null
  footer?: React.ReactNode
}): React.JSX.Element {
  // Unknown counts as reduced, so the card never slides before the setting is read.
  const slide = useReducedMotionEnabled() === false
  useBackClaim(() => {
    onDismiss()
    return true
  })
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
  const right = viewport.x + viewport.width
  const bottom = viewport.y + viewport.height
  const x = Math.max(viewport.x, Math.min(trigger.x, right))
  const y = Math.max(viewport.y, Math.min(trigger.y, bottom))
  const endX = Math.max(x, Math.min(trigger.x + trigger.width, right))
  const endY = Math.max(y, Math.min(trigger.y + trigger.height, bottom))
  // Leave the real title target uncovered for the whole pointer sequence, including exit.
  const bands = [
    {
      key: 'above',
      left: viewport.x,
      top: viewport.y,
      width: viewport.width,
      height: y - viewport.y
    },
    { key: 'below', left: viewport.x, top: endY, width: viewport.width, height: bottom - endY },
    { key: 'left', left: viewport.x, top: y, width: x - viewport.x, height: endY - y },
    { key: 'right', left: endX, top: y, width: right - endX, height: endY - y }
  ]
  return (
    <>
      {bands.map(({ key, ...frame }) => (
        <Pressable
          key={key}
          accessible={false}
          tabIndex={-1}
          style={{ position: 'absolute', ...frame }}
          onPress={onDismiss}
        />
      ))}
      <Animated.View
        ref={contentRef}
        tabIndex={-1}
        style={[
          styles.card,
          {
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
        <ScrollView contentContainerStyle={styles.content} tabIndex={0}>
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
    </>
  )
}

const styles = StyleSheet.create({
  card: {
    position: 'absolute',
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.row,
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
})
