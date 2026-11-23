// One item's page inside the bot panel, in the desktop's order: title, "Item · chat · when", description
// (three lines, Show more), the close note, Status (and Snoozed while it is) and Chat, Done means, Links, Activity, and the comment
// box docked at the bottom. Back returns to the list; up and down step through it, "4 of 6".
import { useEffect, useRef, useState } from 'react'
import { Keyboard, Pressable, ScrollView, Text, View, type ScrollViewInstance } from 'react-native'
import { House, MessageSquare } from 'lucide-react-native'
import { BOTS_ITEM_COMMENT_ATTACHMENTS_RUNTIME_CAPABILITY } from '../../../../src/shared/bot-runtime-capabilities'
import {
  formatBotItemNumber,
  isBotItemLive,
  isBotItemSnoozed,
  type BotItem
} from '../../../../src/shared/bots/bot-items'
import { botItemStatusName } from '../../../../src/shared/bots/bot-item-status-name'
import type { BotChatTreeWorker } from '../../../../src/shared/bots/bot-chat-tree'
import { ListGroup, ListRow, SectionHeader } from '../../components/list/ListGroup'
import { MobileEdgeFade } from '../../components/list/MobileEdgeFade'
import { MobileMarkdown } from '../../components/markdown/MobileMarkdown'
import { useRouteCapability } from '../../worktree/execution-hosts/use-route-capability'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { MobileNativeChatFloatingControls } from '../../session/native-chat/lower-region/MobileNativeChatFloatingControls'
import {
  isAtTail,
  type MobileScrollTailMetrics
} from '../../session/native-chat/transcript/viewport/use-mobile-native-chat-tail-follow'
import { MobileBotTextButton } from '../MobileBotTextButton'
import { botItemWaitingLine } from '../../../../src/shared/bots/bot-item-question-answers'
import { MobileNativeChatPromptStrip } from '../../session/native-chat/input/prompts/MobileNativeChatPromptStrip'
import { MobileBotItemActivity } from './MobileBotItemActivity'
import { useMobileBotItemAskSlot } from './MobileBotItemAskCard'
import { MobileBotItemCommentBox, type BotItemCommentBoxHandle } from './MobileBotItemCommentBox'
import { MobileBotItemLinks } from './MobileBotItemLinks'
import { botItemChatName, type BotItemSheet } from './MobileBotItemSheets'
import { MobileBotItemStatusIcon } from './MobileBotItemStatusIcon'
import { formatPhoneSnoozeTime } from './bot-item-snooze-time'
import { useNow } from '../../hooks/use-now'
import { usePhoneBotItemView } from './use-phone-bot-item-view'
import type { PhoneBotItemStepper } from './use-phone-bot-item-walk'
import { MobileBotItemPageHeader } from './MobileBotItemPageHeader'
import { MobileBotItemSubtitle } from './MobileBotItemSubtitle'
import { usePhoneBotItemPendingComments } from './use-phone-bot-item-pending-comments'

const DESCRIPTION_LINES_HEIGHT = 3 * 20

export function MobileBotItemPage({
  client,
  hostKey,
  hostId,
  bot,
  uid,
  reads,
  online,
  hostName,
  onBack,
  setSheet,
  onOpenChat,
  onOpenWorker,
  onOpenFile,
  onCommentBoxHeight,
  stepper,
  showToast
}: {
  client: RpcClient | null
  /** The paired and execution host the item lives on; two hosts can hold the same bot and item ids. */
  hostKey: string
  /** That host's id, which the bot folder's file and skill reads go through. */
  hostId: string
  bot: { id: string; name: string; folderWorkspaceId: string; agent: string }
  uid: string
  /** Up and down through the list the item opened from; null when it opened from elsewhere. */
  stepper: PhoneBotItemStepper | null
  showToast: (message: string) => void
  reads: number
  online: boolean
  hostName: string
  onBack: () => void
  setSheet: (sheet: BotItemSheet) => void
  onOpenChat: (item: BotItem) => void
  onOpenWorker: (worker: BotChatTreeWorker) => void
  onOpenFile: (path: string) => void
  /** The docked box's height, so a toast sits just above it. */
  onCommentBoxHeight: (height: number) => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const view = usePhoneBotItemView({ client, uid, reads })
  const now = useNow(60_000)
  const comment = useRef<BotItemCommentBoxHandle>(null)
  // An answer on its way or landed: the ask card waits for the item's next event, or comes back if it
  // surely failed, so a second tap never posts it twice.
  const [replyAfter, setReplyAfter] = useState<string | null>(null)
  const lastEventId = view.events.at(-1)?.id ?? ''
  const replyBusy = replyAfter !== null && replyAfter === lastEventId
  const waitingLine = view.item ? botItemWaitingLine(view.item, view.events) : null
  const waitingOn = waitingLine
    ? { replies: waitingLine.replies, asker: view.item?.owner.name ?? bot.name }
    : null
  const ask = useMobileBotItemAskSlot({
    item: view.item,
    events: view.events,
    online: online && !view.failed,
    pending: replyBusy,
    send: async (text) => {
      setReplyAfter(lastEventId)
      const outcome = (await comment.current?.send(text)) ?? 'failed'
      if (outcome === 'failed') {
        setReplyAfter(null)
      }
      return outcome
    }
  })
  const askShown = ask.card !== null && ask.strip === null
  useEffect(() => {
    // The card takes the comment box's place: a keyboard up for the box would type into it unseen.
    if (askShown) {
      Keyboard.dismiss()
    }
  }, [askShown])
  const jump = useJumpToEnd()
  const takesImages = useRouteCapability(BOTS_ITEM_COMMENT_ATTACHMENTS_RUNTIME_CAPABILITY)
  const pending = usePhoneBotItemPendingComments({
    client,
    key: `${hostKey}\0${bot.id}\0${uid}`,
    uid,
    events: view.events,
    hostName,
    showToast
  })
  const back = <MobileBotItemPageHeader stepper={stepper} online={online} onBack={onBack} />
  const item = view.item
  if (!item) {
    return (
      <View style={styles.page}>
        {back}
        {view.failed ? (
          <View style={styles.missing}>
            <Text style={styles.missingTitle}>
              {t('bots.items.open.failed', 'Couldn’t open this item.')}
            </Text>
            <Text style={styles.missingBody}>
              {view.notFound
                ? t(
                    'bots.items.open.notFound',
                    '{{host}} didn’t find it. It may belong to a bot on another computer.',
                    { host: hostName }
                  )
                : t('bots.items.open.noAnswer', '{{host}} didn’t answer.', { host: hostName })}
            </Text>
            <MobileBotTextButton label={t('bots.items.retry', 'Retry')} onPress={view.retry} />
          </View>
        ) : (
          <Text style={styles.missingBody}>{t('bots.items.loading', 'Loading items…')}</Text>
        )}
      </View>
    )
  }
  const chatTitle = botItemChatName(item, t)
  const ChatIcon = item.chat.kind === 'home' ? House : MessageSquare
  const closed = item.status === 'done' || item.status === 'canceled'
  return (
    <View style={styles.page}>
      {back}
      <View style={styles.scroll}>
        <ScrollView
          ref={jump.ref}
          style={styles.scroll}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          onScroll={(event) => jump.measure(event.nativeEvent)}
          onContentSizeChange={(_width, height) => jump.measure({ contentSize: { height } })}
          onLayout={(event) =>
            jump.measure({ layoutMeasurement: { height: event.nativeEvent.layout.height } })
          }
          scrollEventThrottle={32}
        >
          <View style={styles.head}>
            <Text style={styles.title}>
              <Text style={styles.number}>{formatBotItemNumber(item.number)} </Text>
              {item.title}
            </Text>
            <MobileBotItemSubtitle item={item} chatTitle={chatTitle} />
            {item.description ? <ClampedDescription text={item.description} /> : null}
          </View>
          {view.failed ? (
            <ListGroup>
              <ListRow
                title={t('bots.items.readFailedShort', 'Couldn’t load items.')}
                subtitle={t('bots.items.lastRead', 'Showing the last items read.')}
                accessory={
                  <MobileBotTextButton
                    label={t('bots.items.retry', 'Retry')}
                    onPress={view.retry}
                  />
                }
              />
            </ListGroup>
          ) : null}
          {closed && item.closeNote ? (
            <View style={styles.note}>
              <Text style={styles.noteText}>
                {item.status === 'canceled'
                  ? t('bots.items.view.canceledNote', 'Canceled:')
                  : t('bots.items.view.doneNote', 'Done:')}{' '}
                <Text style={styles.noteBody}>{item.closeNote}</Text>
              </Text>
            </View>
          ) : null}
          <ListGroup>
            <ListRow
              title={t('bots.items.field.status', 'Status')}
              accessory={
                <View style={styles.value}>
                  <MobileBotItemStatusIcon status={item.status} live={isBotItemLive(item)} />
                  <Text style={styles.valueText}>{botItemStatusName(item.status, t)}</Text>
                </View>
              }
              navigates
              disabled={!online || view.failed}
              onPress={() => setSheet({ kind: 'status', item })}
            />
            {item.snoozedUntil !== null && isBotItemSnoozed(item, now) ? (
              <ListRow
                title={t('bots.items.field.snoozed', 'Snoozed')}
                accessory={
                  <Text style={styles.valueText}>
                    {t('bots.items.snooze.rowUntil', 'until {{when}}', {
                      when: formatPhoneSnoozeTime(item.snoozedUntil, now)
                    })}
                  </Text>
                }
                navigates
                disabled={!online || view.failed}
                onPress={() => setSheet({ kind: 'snooze', items: [item] })}
              />
            ) : null}
            <ListRow
              title={t('bots.items.field.chat', 'Chat')}
              accessory={
                <View style={styles.value}>
                  <ChatIcon size={14} color={colors.textSecondary} />
                  <Text style={styles.valueText} numberOfLines={1}>
                    {chatTitle}
                  </Text>
                </View>
              }
              navigates
              onPress={() => onOpenChat(item)}
            />
          </ListGroup>
          {item.doneMeans ? (
            <View style={styles.doneMeans}>
              <Text style={styles.doneMeansLabel}>
                {t('bots.items.field.doneMeans', 'Done means')}
              </Text>
              <Text style={styles.doneMeansText}>{item.doneMeans}</Text>
            </View>
          ) : null}
          {item.links.length > 0 ? (
            <>
              <SectionHeader
                title={`${t('bots.items.view.links', 'Links')} ${item.links.length}`}
              />
              <MobileBotItemLinks
                bot={bot}
                links={item.links}
                onOpenWorker={onOpenWorker}
                onOpenFile={onOpenFile}
              />
            </>
          ) : null}
          <SectionHeader title={t('bots.items.view.activity', 'Activity')} />
          {view.hasEarlier ? (
            <MobileBotTextButton
              label={t('bots.items.view.showEarlier', 'Show earlier')}
              onPress={view.loadEarlier}
            />
          ) : null}
          <MobileBotItemActivity
            item={item}
            events={view.events}
            attachments={{ client, onOpenFile }}
            pending={pending}
            onReveal={jump.center}
          />
        </ScrollView>
        {/* A soft edge over the comment box: activity scrolling under it reads as more below. */}
        <MobileEdgeFade edge="bottom" color={colors.sheetSurface} />
        <MobileNativeChatFloatingControls showJumpToTail={jump.shown} onJumpToTail={jump.toEnd} />
      </View>
      <View
        style={askShown ? styles.askDock : undefined}
        onLayout={(event) => onCommentBoxHeight(event.nativeEvent.layout.height)}
      >
        <View style={ask.strip ? styles.hidden : styles.askSlot}>{ask.card}</View>
        <MobileNativeChatPromptStrip prompt={ask.strip} />
        {/* Kept mounted under the card: it sends the card's answer. */}
        <View style={askShown ? styles.hidden : undefined}>
          <MobileBotItemCommentBox
            ref={comment}
            client={client}
            item={item}
            online={online && !view.failed}
            hostName={hostName}
            waitingOn={waitingOn}
            attachTo={takesImages && !item.chat.gone ? item.chat.id : null}
            hostId={hostId}
            bot={bot}
            onComment={(text, paths, skills) => {
              pending.send(text, paths, lastEventId || null, undefined, undefined, skills)
              requestAnimationFrame(jump.toEnd)
            }}
            showToast={showToast}
          />
        </View>
      </View>
    </View>
  )
}

/** Chat's Scroll to latest, on a page that keeps its opening place: shown while the end is out of view. */
function useJumpToEnd() {
  const ref = useRef<ScrollViewInstance>(null)
  const metrics = useRef<MobileScrollTailMetrics>({
    contentOffset: { y: 0 },
    contentSize: { height: 0 },
    layoutMeasurement: { height: 0 }
  })
  const [shown, setShown] = useState(false)
  return {
    ref,
    shown,
    measure: (next: Partial<MobileScrollTailMetrics>) => {
      metrics.current = { ...metrics.current, ...next }
      setShown(!isAtTail(metrics.current))
    },
    toEnd: () => ref.current?.scrollToEnd({ animated: true }),
    /** A span measured in the window to the middle of the view, as the desktop centres a question. */
    center: (y: number, height: number, animated: boolean) =>
      ref.current?.measureInWindow((_x, top, _width, view) => {
        const at = metrics.current.contentOffset.y + y - top - (view - height) / 2
        ref.current?.scrollTo({ y: Math.max(0, at), animated })
      })
  }
}

/** The description's first three lines, then Show more; Markdown, as the desktop draws it. */
function ClampedDescription({ text }: { text: string }) {
  const t = useMobileTranslation()
  const [open, setOpen] = useState(false)
  const [height, setHeight] = useState(0)
  const clamps = height > DESCRIPTION_LINES_HEIGHT + 4
  return (
    <View style={styles.description}>
      <View style={!open && clamps ? styles.clamped : undefined}>
        <View onLayout={(event) => setHeight(event.nativeEvent.layout.height)}>
          <MobileMarkdown content={text} />
        </View>
      </View>
      {clamps ? (
        <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" hitSlop={6}>
          <Text style={styles.showMore}>
            {open
              ? t('bots.items.view.showLess', 'Show less')
              : t('bots.items.view.showMore', 'Show more')}
          </Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  page: { flex: 1, backgroundColor: colors.sheetSurface },
  hidden: { display: 'none' },
  // As chat caps its card: the activity stays in view and a tall card scrolls inside.
  askDock: { flexShrink: 1, minHeight: 0, maxHeight: '60%' },
  askSlot: { flexShrink: 1, minHeight: 0 },
  scroll: { flex: 1 },
  content: { gap: spacing.sm, paddingBottom: spacing.lg },
  head: { paddingHorizontal: spacing.xs, gap: spacing.xs },
  title: { fontSize: typography.titleSize, fontWeight: '600', color: colors.textPrimary },
  number: { fontWeight: '400', color: colors.textMuted, fontVariant: ['tabular-nums'] },
  description: { marginTop: spacing.xs, gap: spacing.xs },
  clamped: { maxHeight: DESCRIPTION_LINES_HEIGHT, overflow: 'hidden' },
  showMore: { fontSize: 13, fontWeight: '600', color: colors.textPrimary },
  note: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.surface,
    backgroundColor: colors.sheetGroup
  },
  noteText: { fontSize: 13, color: colors.textMuted, lineHeight: 18 },
  noteBody: { color: colors.textPrimary },
  value: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: 180 },
  valueText: { fontSize: 15, color: colors.textSecondary, flexShrink: 1 },
  doneMeans: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.surface,
    backgroundColor: colors.sheetGroup,
    gap: 2
  },
  doneMeansLabel: { fontSize: 13, color: colors.textMuted },
  doneMeansText: { fontSize: 15, lineHeight: 20, color: colors.textPrimary },
  missing: { alignItems: 'center', paddingVertical: spacing.xl, gap: spacing.sm },
  missingTitle: { fontSize: typography.bodySize, fontWeight: '600', color: colors.textPrimary },
  missingBody: {
    fontSize: 13,
    color: colors.textMuted,
    textAlign: 'center',
    paddingHorizontal: spacing.lg
  }
}))
