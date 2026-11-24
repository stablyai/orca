import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, CircleDashed, MessageCircleQuestion } from 'lucide-react-native'
import { Pressable, ScrollView, View, type ScrollViewInstance } from 'react-native'
import {
  botPreviewSignal,
  rankBotsForPreview,
  type BotPreviewSignal
} from '../../../src/shared/bots/bot-collapsed-preview'
import { AgentSpinner } from '../agents/presentation/AgentSpinner'
import { MobileEdgeFade } from '../components/list/MobileEdgeFade'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useReducedMotionEnabled } from '../platform/accessibility/use-reduced-motion'
import { colors } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { Section } from '../worktree/workspace-list/workspace-list-types'
import { MobileBotAvatar } from './MobileBotAvatar'

type Bot = NonNullable<Section['botPreview']>[number]

const FACE_SIZE = 20
const INSET = 4
const FACE_STEP = FACE_SIZE + INSET
const EDGE_WIDTH = 12
const TRACK_HEIGHT = FACE_SIZE + 2 * INSET

function previewWindow(offset: number, width: number, total: number, count: number) {
  const max = Math.max(0, total - width)
  const left = Math.max(0, Math.min(max, offset))
  const right = left + width
  return {
    first: Math.floor(left / FACE_STEP),
    end: Math.max(0, Math.min(count, Math.ceil((right - INSET) / FACE_STEP))),
    firstFull: left > 0 ? Math.min(count, Math.ceil((left + EDGE_WIDTH - INSET) / FACE_STEP)) : 0,
    endFull: left < max ? Math.max(0, Math.floor((right - INSET - EDGE_WIDTH) / FACE_STEP)) : count
  }
}

export function MobileCollapsedBotPreview({ bots }: { bots: readonly Bot[] }) {
  useMobileColorScheme()
  const reduceMotion = useReducedMotionEnabled()
  const scroll = useRef<ScrollViewInstance>(null)
  const scrollOffset = useRef(0)
  const [available, setAvailable] = useState(0)
  const [offset, setOffset] = useState(0)
  const ordered = useMemo(
    () => rankBotsForPreview(bots).map((bot) => ({ bot, signal: botPreviewSignal(bot) })),
    [bots]
  )
  const total = bots.length * FACE_STEP + INSET
  const overflow = available > 0 && total > available
  const width = overflow
    ? Math.min(
        available,
        Math.max(0, Math.floor((available - INSET - EDGE_WIDTH) / FACE_STEP)) * FACE_STEP +
          INSET +
          EDGE_WIDTH
      )
    : Math.min(available, total)
  const max = total - width
  const { first, end, firstFull, endFull } = previewWindow(offset, width, total, bots.length)
  const start = Math.max(0, first - 1)
  const stop = Math.min(bots.length, end + 1)

  useLayoutEffect(() => {
    if (scrollOffset.current > max) {
      scrollOffset.current = max
      scroll.current?.scrollTo({ x: max, animated: false })
      setOffset(max)
    }
  }, [max])

  function updateOffset(next: number): void {
    scrollOffset.current = Math.max(0, Math.min(max, next))
    setOffset((previous) => {
      const prior = previewWindow(previous, width, total, bots.length)
      const window = previewWindow(next, width, total, bots.length)
      return prior.first === window.first &&
        prior.end === window.end &&
        prior.firstFull === window.firstFull &&
        prior.endFull === window.endFull
        ? previous
        : next
    })
  }

  function page(direction: -1 | 1): void {
    const step = Math.max(1, Math.floor(width / FACE_STEP) - 1) * FACE_STEP
    const target = Math.max(0, Math.min(max, scrollOffset.current + direction * step))
    const animated = reduceMotion === false
    scroll.current?.scrollTo({ x: target, animated })
    if (!animated) {
      updateOffset(target)
    }
  }

  return (
    <View
      style={[styles.preview, overflow && styles.previewOverflow]}
      onLayout={(event) => setAvailable(event.nativeEvent.layout.width)}
    >
      {width > 0 ? (
        <View style={{ width, height: TRACK_HEIGHT }}>
          {overflow && firstFull > 0 ? (
            <PreviewEdge
              direction={-1}
              count={firstFull}
              signal={ordered[0]?.signal ?? null}
              onPress={() => page(-1)}
            />
          ) : null}
          <ScrollView
            ref={scroll}
            horizontal
            scrollEnabled={overflow}
            directionalLockEnabled
            nestedScrollEnabled
            showsHorizontalScrollIndicator={false}
            alwaysBounceHorizontal={false}
            keyboardShouldPersistTaps="handled"
            scrollEventThrottle={16}
            onScroll={(event) => updateOffset(event.nativeEvent.contentOffset.x)}
          >
            <View
              style={{ width: total, height: TRACK_HEIGHT }}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              {ordered.slice(start, stop).map(({ bot, signal }, position) => {
                const index = start + position
                return (
                  <View key={bot.id} style={[styles.avatar, { left: INSET + index * FACE_STEP }]}>
                    <MobileBotAvatar avatar={bot.avatar} size={FACE_SIZE} circular />
                    {index >= firstFull && index < endFull ? (
                      <PreviewStatus signal={signal} />
                    ) : null}
                  </View>
                )
              })}
            </View>
          </ScrollView>
          {overflow && endFull < bots.length ? (
            <PreviewEdge
              direction={1}
              count={bots.length - endFull}
              signal={ordered[endFull]?.signal ?? null}
              onPress={() => page(1)}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

function PreviewEdge({
  direction,
  count,
  signal,
  onPress
}: {
  direction: -1 | 1
  count: number
  signal: BotPreviewSignal
  onPress: () => void
}) {
  const t = useMobileTranslation()
  const left = direction === -1
  const Chevron = left ? ChevronLeft : ChevronRight
  const action = left
    ? t('bots.section.scrollLeft', 'Scroll left · {{amount}} hidden', { amount: count })
    : t('bots.section.scrollRight', 'Scroll right · {{amount}} hidden', { amount: count })
  const hint =
    signal === 'attention'
      ? t('bots.chats.needsYou', 'Needs you')
      : signal === 'unread'
        ? t('bots.chats.unread', 'Unread')
        : signal === 'working'
          ? t('sidebar.cardSlot.working', 'Working')
          : null
  return (
    <Pressable
      onPress={onPress}
      hitSlop={{ top: 8, bottom: 8, left: left ? 0 : 24, right: left ? 24 : 0 }}
      accessibilityRole="button"
      accessibilityLabel={hint ? `${action} · ${hint}` : action}
      style={[styles.edge, left ? styles.edgeLeft : styles.edgeRight]}
    >
      <MobileEdgeFade edge={left ? 'left' : 'right'} size={EDGE_WIDTH} color={colors.bgBase} />
      <Chevron size={10} color={colors.textPrimary} />
      <PreviewStatus signal={signal} edge />
    </Pressable>
  )
}

function PreviewStatus({ signal, edge = false }: { signal: BotPreviewSignal; edge?: boolean }) {
  if (signal === 'unread') {
    return <View style={[styles.unread, edge && styles.edgeUnread]} />
  }
  if (!signal) {
    return null
  }
  return (
    <View style={[styles.status, edge && styles.edgeStatus]}>
      {signal === 'attention' ? (
        <MessageCircleQuestion size={edge ? 10 : 12} color={colors.agentQuestion} />
      ) : edge ? (
        <CircleDashed size={10} color={colors.statusAmber} />
      ) : (
        <AgentSpinner status="working" />
      )}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  preview: { flex: 1, minWidth: 0, height: TRACK_HEIGHT, marginVertical: -6, alignItems: 'center' },
  previewOverflow: { alignItems: 'flex-start' },
  avatar: {
    position: 'absolute',
    top: INSET,
    width: FACE_SIZE,
    height: FACE_SIZE,
    borderRadius: FACE_SIZE / 2,
    outlineWidth: 2,
    outlineColor: colors.bgBase
  },
  edge: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    zIndex: 1,
    width: EDGE_WIDTH,
    alignItems: 'center',
    justifyContent: 'center'
  },
  edgeLeft: { left: 0 },
  edgeRight: { right: 0 },
  status: {
    position: 'absolute',
    right: -4,
    bottom: -4,
    width: 12,
    height: 12,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgBase
  },
  edgeStatus: { right: 0, bottom: -2 },
  unread: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: colors.bgBase,
    backgroundColor: colors.accentBlue
  },
  edgeUnread: { right: 1, bottom: -2 }
}))
