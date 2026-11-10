import type { ReactNode, RefObject } from 'react'
import { Animated, ScrollView, StyleSheet, Text, View, type HostInstance } from 'react-native'
import { DetailCardFocusBoundary, DetailCardLayer } from './detail-card-host'
import type { AnchoredDetailCardState } from './use-anchored-detail-card'
import { useDetailCardMotion } from './use-detail-card-motion'
import { useReducedMotionEnabled } from '../platform/use-reduced-motion'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

/** Below a trigger by the card's leading/top edges, or above it by its trailing/bottom edges. */
export type DetailCardPlacement =
  | { side: 'below'; left: number; top: number }
  | { side: 'above'; right: number; bottom: number }

export type DetailCardAnchor = DetailCardPlacement & { origin: { x: number; y: number } }

const CARD_WIDTH = 256
const EDGE_INSET = spacing.sm
const TRANSITION_MS = 150
const SLIDE_FROM = -6

type DetailCardContent = {
  title: string
  titleTrailing?: string
  detail?: string | null
  children?: ReactNode
  footer?: ReactNode
}

/** The full-screen layer an anchored card measures from and draws in, with the card while it shows. */
export function AnchoredDetailCardLayer({
  card,
  obscured,
  layerRef,
  ...content
}: DetailCardContent & {
  card: AnchoredDetailCardState
  obscured: boolean
  /** Replaces the hook's layer ref, for a caller that also needs the node. */
  layerRef?: (view: HostInstance | null) => void
}): React.JSX.Element {
  const reducedMotion = useReducedMotionEnabled()
  return (
    <DetailCardLayer>
      <View
        ref={layerRef ?? card.layerRef}
        collapsable={false}
        pointerEvents="box-none"
        onLayout={card.onLayout}
        style={layerStyle}
      >
        {card.visual ? (
          <AnchoredDetailCard
            {...card.visual}
            {...content}
            reducedMotion={reducedMotion}
            bounds={card.bounds}
            layerHeight={card.layerHeight}
            contentRef={card.contentRef}
            boundaryRefs={card.boundaryRefs}
            active={card.active}
            obscured={obscured}
            onSettled={card.onSettled}
          />
        ) : null}
      </View>
    </DetailCardLayer>
  )
}

const layerStyle = { ...StyleSheet.absoluteFill, zIndex: 1000 }

/** Only the current motion may release the retained exit presentation. */
function AnchoredDetailCard({
  anchor,
  target,
  motion,
  bounds,
  layerHeight,
  contentRef,
  boundaryRefs,
  active,
  obscured,
  reducedMotion,
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
  contentRef: RefObject<HostInstance | null>
  boundaryRefs: RefObject<unknown[]>
  active: boolean
  obscured: boolean
  reducedMotion: boolean | null
  onSettled: (motion: number) => void
} & DetailCardContent): React.JSX.Element {
  useMobileColorScheme()
  // Unknown counts as reduced, so the card never slides before the setting is read.
  const slide = reducedMotion === false
  const motionStyle = useDetailCardMotion({
    contentRef,
    motion,
    target,
    slide,
    offset: anchor.side === 'below' ? SLIDE_FROM : -SLIDE_FROM,
    duration: TRANSITION_MS,
    onSettled
  })

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
            width
          },
          motionStyle
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
    // Lets a long unbroken workspace name wrap inside the row instead of overflowing it.
    minWidth: 0,
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
