// Reorder the computer's bots and groups, one order shared with its sidebar, when it sorts them Manual.
// The phone's host list is virtualized, so the drag happens here, on the drag list Terminal shortcuts use.
import { useCallback, useState } from 'react'
import { Alert, Text, View } from 'react-native'
import Animated, {
  useAnimatedRef,
  useAnimatedScrollHandler,
  useSharedValue
} from 'react-native-reanimated'
import { sortBotsBySidebarOrder, type BotHomeOwner } from '../../../src/shared/bots/bot-homes'
import { botGroupMemberBots } from '../../../src/shared/bots/bot-sidebar-entries'
import { BottomDrawer } from '../components/bottom-drawer/BottomDrawer'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { ListGroup } from '../components/list/ListGroup'
import { DragReorderList } from '../components/reorder/DragReorderList'
import { setDragReorderScrollEnabled } from '../components/reorder/drag-reorder-scroll-lock'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
import { useMobileColors } from '../theme/use-mobile-color-scheme'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { botUpdate } from './bot-sheet-operations'
import { groupReorder } from './bot-group-operations'
import type { ListedHostBots } from './host-bot-listing'
import { mobileBotAvatarSource } from './host-bot-row-facts'
import { MobileBotAvatar } from './MobileBotAvatar'
import { MobileBotFaceStack } from './MobileBotFaceStack'

const ROW_HEIGHT = 56

type Entry = Pick<BotHomeOwner, 'sidebarOrder' | 'createdAt'> & {
  key: string
  id: string
  name: string
  kind: 'bot' | 'group'
  faces: { id: string; avatar: ReturnType<typeof mobileBotAvatarSource> }[]
}

/** The listing's bots and groups in their saved order, as the Bots section lists them in Manual. */
export function botsReorderEntries(listing: ListedHostBots): Entry[] {
  const face = (bot: ListedHostBots['bots'][number]) => ({
    id: bot.id,
    avatar: mobileBotAvatarSource(bot)
  })
  return sortBotsBySidebarOrder<Entry>([
    ...listing.bots.map((bot) => ({
      ...bot,
      key: `bot:${bot.id}`,
      kind: 'bot' as const,
      faces: [face(bot)]
    })),
    ...(listing.groups ?? []).map((group) => ({
      ...group,
      key: `group:${group.id}`,
      kind: 'group' as const,
      faces: botGroupMemberBots(group, listing.bots).map(face)
    }))
  ])
}

/** `entries` in the order of `keys`; a row not in it (made since) leads, as a new row does. */
function orderByKeys(entries: readonly Entry[], keys: readonly string[]): Entry[] {
  const rank = new Map(keys.map((key, index) => [key, index]))
  return entries.toSorted((a, b) => (rank.get(a.key) ?? -1) - (rank.get(b.key) ?? -1))
}

/** The places these rows may take. The desktop numbers one list across every computer, so this
 *  computer's rows trade the places they already hold and a server's bots keep theirs; rows never
 *  placed (or sharing a place) are numbered from 0, as the desktop's first drop does. */
function orderSlots(entries: readonly Entry[]): number[] {
  const held = entries.flatMap((entry) =>
    typeof entry.sidebarOrder === 'number' ? [entry.sidebarOrder] : []
  )
  return held.length === entries.length && new Set(held).size === held.length
    ? held.toSorted((a, b) => a - b)
    : entries.map((_, index) => index)
}

export function MobileBotsReorderSheet({
  visible,
  onClose,
  client,
  listing
}: {
  visible: boolean
  onClose: () => void
  client: RpcClient | null
  /** The paired computer's bots: groups are its alone, and a relayed server's keep their own order. */
  listing: ListedHostBots | null
}) {
  return (
    <BottomDrawer
      visible={visible}
      onClose={onClose}
      fillAvailable
      contentScrollable={false}
      dragContentToDismiss={false}
    >
      {listing ? <Content client={client} listing={listing} onClose={onClose} /> : null}
    </BottomDrawer>
  )
}

function Content({
  client,
  listing,
  onClose
}: {
  client: RpcClient | null
  listing: ListedHostBots
  onClose: () => void
}) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  // The order a drop made, over the live listing until the host's catches up: rows made or deleted
  // meanwhile join or leave it.
  const [dropped, setDropped] = useState<readonly string[] | null>(null)
  const live = botsReorderEntries(listing)
  // Once the host's order is the dropped one, the host's order shows again (and others' changes with it).
  const liveKeys = live.map((entry) => entry.key).join('\n')
  if (
    dropped &&
    orderByKeys(live, dropped)
      .map((entry) => entry.key)
      .join('\n') === liveKeys
  ) {
    setDropped(null)
  }
  const entries = dropped ? orderByKeys(live, dropped) : live
  const scrollRef = useAnimatedRef<Animated.ScrollView>()
  const scrollOffsetY = useSharedValue(0)
  const scrollContentHeight = useSharedValue(0)
  const onScroll = useAnimatedScrollHandler((event) => {
    scrollOffsetY.value = event.contentOffset.y
  })
  // Toggled imperatively: a rerender during the drag rebuilds row gestures and can cancel it.
  const onDragActiveChange = useCallback(
    (active: boolean) => setDragReorderScrollEnabled(scrollRef, !active),
    [scrollRef]
  )
  const reorder = (keys: string[]) => {
    const next = orderByKeys(live, keys)
    const slots = orderSlots(live)
    // Every row is written: a second drop can land before the host's re-read says what the first
    // saved, and a full write leaves no two rows in one place.
    const moved = next.map((entry, index) => ({ entry, order: slots[index]! }))
    setDropped(keys)
    if (!client) {
      return
    }
    void Promise.all(
      moved.map(({ entry, order }) =>
        entry.kind === 'bot'
          ? botUpdate
              .request(
                client,
                { botId: entry.id, updates: { sidebarOrder: order } },
                { failWhenDisconnected: true }
              )
              .then(botUpdate.interpret)
          : groupReorder
              .request(
                client,
                { groupId: entry.id, sidebarOrder: order },
                { failWhenDisconnected: true }
              )
              .then(groupReorder.interpret)
      )
    ).catch((error: unknown) => {
      // The host's order stands; the list shows it again.
      setDropped(null)
      Alert.alert(error instanceof Error ? error.message : String(error))
    })
  }
  return (
    <View style={styles.root}>
      <SheetHeader
        title={t('bots.section.reorderTitle', 'Reorder bots')}
        trailing={{ label: t('common.done', 'Done'), onPress: onClose }}
      />
      <Animated.ScrollView
        ref={scrollRef}
        style={styles.root}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onContentSizeChange={(_width, height) => {
          scrollContentHeight.value = height
        }}
      >
        <ListGroup>
          <DragReorderList
            items={entries}
            itemKey={(entry) => entry.key}
            rowHeight={ROW_HEIGHT}
            scrollRef={scrollRef}
            scrollOffsetY={scrollOffsetY}
            scrollContentHeight={scrollContentHeight}
            onDragActiveChange={onDragActiveChange}
            onReorder={reorder}
            renderRow={(entry) => (
              <View style={styles.row}>
                {entry.kind === 'group' ? (
                  <MobileBotFaceStack faces={entry.faces} slot={32} ringColor={colors.sheetGroup} />
                ) : entry.faces[0] ? (
                  <MobileBotAvatar avatar={entry.faces[0].avatar} size={32} />
                ) : null}
                <Text style={styles.name} numberOfLines={1}>
                  {entry.name}
                </Text>
              </View>
            )}
          />
        </ListGroup>
      </Animated.ScrollView>
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  root: { flex: 1 },
  content: { paddingHorizontal: spacing.md, paddingBottom: spacing.xl },
  row: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingLeft: spacing.lg
  },
  name: { flex: 1, fontSize: typography.bodySize, color: colors.textPrimary }
}))
