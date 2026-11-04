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
// easeOutCubic, the same curve as Easing.out(Easing.cubic).
const EASE_OUT_CUBIC = 'cubic-bezier(0.33, 1, 0.68, 1)'

type AnchoredDetailCardProps = {
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
  /** Settled preference from a mounted parent. Omit to read it here. */
  reducedMotion?: boolean | null
}

/** Only the current motion may release the retained exit presentation. */
export function AnchoredDetailCard(props: AnchoredDetailCardProps): React.JSX.Element {
  if (props.reducedMotion === undefined) {
    return <AnchoredDetailCardMotion {...props} />
  }
  return <AnchoredDetailCardFrame {...props} reducedMotion={props.reducedMotion} />
}

function AnchoredDetailCardMotion(
  props: Omit<AnchoredDetailCardProps, 'reducedMotion'>
): React.JSX.Element {
  return <AnchoredDetailCardFrame {...props} reducedMotion={useReducedMotionEnabled()} />
}

function AnchoredDetailCardFrame({
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
  footer,
  reducedMotion
}: AnchoredDetailCardProps & { reducedMotion: boolean | null }): React.JSX.Element {
  useMobileColorScheme()
  // Unknown counts as reduced, so the card never slides before the setting is read.
  const slide = reducedMotion === false
  const [progress] = useState(() => new Animated.Value(0))
  const webState = useState(() => ({
    value: 0,
    from: 0,
    to: 0,
    animation: null as Animation | null
  }))[0]
  useLayoutEffect(
    () => () => {
      webState.animation?.cancel()
      webState.animation = null
    },
    [webState]
  )
  useLayoutEffect(() => {
    let disposed = false
    const node = detailCardElement(contentRef.current)
    if (node) {
      if (webState.animation && webState.animation.playState !== 'finished') {
        webState.value = detailCardPlayback(webState.animation, webState.from, webState.to)
      }
      const from = webState.value
      if (target === 0 && from === 0) {
        webState.animation?.cancel()
        webState.animation = null
        onSettled(motion)
        return
      }
      if (from === target) {
        return
      }
      webState.animation?.cancel()
      // Web Animations run on the compositor, so main-thread tab work cannot drop this fade.
      const animation = node.animate(detailCardFrames(from, target, slide), {
        duration: TRANSITION_MS,
        easing: EASE_OUT_CUBIC,
        fill: 'both'
      })
      webState.from = from
      webState.to = target
      webState.animation = animation
      animation.onfinish = () => {
        if (disposed || webState.animation !== animation) {
          return
        }
        webState.value = target
        if (target === 0) {
          commitDetailCardExit(() => onSettled(motion))
        }
      }
      return () => {
        disposed = true
      }
    }
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
  }, [motion, target, progress, webState, onSettled, slide, contentRef])

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

function detailCardElement(node: unknown): HTMLElement | null {
  if (typeof HTMLElement === 'undefined' || !(node instanceof HTMLElement)) {
    return null
  }
  return typeof node.animate === 'function' ? node : null
}

function detailCardFrames(from: number, to: number, slide: boolean): Keyframe[] {
  const frame = (opacity: number): Keyframe =>
    slide ? { opacity, transform: `translateY(${SLIDE_FROM * (1 - opacity)}px)` } : { opacity }
  return [frame(from), frame(to)]
}

function detailCardPlayback(animation: Animation, from: number, to: number): number {
  const timing = animation.effect?.getComputedTiming().progress
  const eased = typeof timing === 'number' ? timing : 0
  return from + (to - from) * eased
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
