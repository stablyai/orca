// One item's page inside the bot panel, in the desktop's order: title, description (three lines, Show
// more), the close note, Status (what it waits on under it) and Snoozed while it is, Chat, Done means,
// Links, Activity, and the comment box docked at the bottom. The agent's question docks chat's answer
// card in the box's place. Back returns to the list; up and down step through it, "4 of 6".
import { useRef } from 'react'
import { ScrollView, Text, View, type TextInputInstance } from 'react-native'
import { House, MessageSquare } from 'lucide-react-native'
import {
  BOTS_ITEM_ATTACHMENT_STAGING_RUNTIME_CAPABILITY,
  BOTS_ITEM_COMMENT_ATTACHMENTS_RUNTIME_CAPABILITY
} from '../../../../src/shared/bot-runtime-capabilities'
import { botItemAttachmentTarget } from '../../../../src/shared/agent-session/agent-session-attachments'
import {
  formatBotItemNumber,
  isBotItemLive,
  isBotItemSnoozed,
  type BotItem
} from '../../../../src/shared/bots/bot-items'
import { botItemStatusName } from '../../../../src/shared/bots/bot-item-status-name'
import { isBotItemReplyingTo } from '../../../../src/shared/bots/bot-item-replying'
import type { BotChatTreeWorker } from '../../../../src/shared/bots/bot-chat-tree'
import { ListGroup, ListRow, SectionHeader } from '../../components/list/ListGroup'
import { MobileEdgeFade } from '../../components/list/MobileEdgeFade'
import { useRouteCapability } from '../../worktree/execution-hosts/use-route-capability'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { MobileNativeChatFloatingControls } from '../../session/native-chat/lower-region/MobileNativeChatFloatingControls'
import { MobileBotTextButton } from '../MobileBotTextButton'
import type { BotItemQuestionStepsSend } from '../../../../src/shared/bots/use-bot-item-question-steps'
import { MobileBotItemActivity } from './MobileBotItemActivity'
import { MobileBotItemCommentBox } from './MobileBotItemCommentBox'
import { botItemOpenAsk, useMobileBotItemAskSlot } from './MobileBotItemAskCard'
import { botItemAskCardKey } from './bot-item-ask-card-drafts'
import { MobileNativeChatOpenFileContext } from '../../session/native-chat/links/mobile-native-chat-open-file-context'
import { MobileNativeChatPromptStrip } from '../../session/native-chat/input/prompts/MobileNativeChatPromptStrip'
import { MobileBotItemLinks } from './MobileBotItemLinks'
import { botItemChatName, type BotItemSheet } from './MobileBotItemSheets'
import { MobileBotItemStatusIcon } from './MobileBotItemStatusIcon'
import { formatPhoneSnoozeTime } from './bot-item-snooze-time'
import { useNow } from '../../hooks/use-now'
import { useBotItemActivityFollow } from './use-bot-item-activity-follow'
import { usePhoneBotItemView } from './use-phone-bot-item-view'
import type { PhoneBotItemStepper } from './use-phone-bot-item-walk'
import { MobileBotItemPageHeader } from './MobileBotItemPageHeader'
import { MobileBotItemDescription } from './MobileBotItemDescription'
import { usePhoneBotItemPendingComments } from './use-phone-bot-item-pending-comments'
import {
  botItemCommentDraftKey,
  quoteIntoBotItemCommentDraft,
  useBotItemCommentDraftEmpty
} from './bot-item-comment-drafts'
import { useMobileNativeChatDraftInputs } from '../../session/native-chat/composer/drafts/mobile-native-chat-draft-inputs'
import { useBotItemQuestionSteps } from './use-phone-bot-item-question-steps'
import { MobileNativeChatComposerMenuHost } from '../../session/native-chat/composer/menus/MobileNativeChatComposerMenuHost'

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
  const lastEventId = view.events.at(-1)?.id ?? ''
  const takesImages = useRouteCapability(BOTS_ITEM_COMMENT_ATTACHMENTS_RUNTIME_CAPABILITY)
  const stagesImages = useRouteCapability(BOTS_ITEM_ATTACHMENT_STAGING_RUNTIME_CAPABILITY)
  // One item on one host: its pending comments and its asks' held answers.
  const itemKey = botItemAskCardKey(hostKey, bot.id, uid)
  const pending = usePhoneBotItemPendingComments({
    client,
    key: itemKey,
    uid,
    events: view.events,
    hostName,
    showToast,
    draftKey: botItemCommentDraftKey(hostId, uid),
    refresh: view.retry
  })
  // From the comment box or the answer card: shown at once, then sent to the host.
  const jump = useBotItemActivityFollow({
    scopeKey: itemKey,
    hasItems: view.events.length + pending.shown.length > 0
  })
  const sendComment: BotItemQuestionStepsSend = (text, paths = [], ...rest) => {
    pending.send(text, paths, lastEventId || null, ...rest)
    jump.jumpToTail()
  }
  // `waitingLine`: the question the comment box names, until a reply is on its way.
  // Its words and photos, as the comment box keeps them: a draft's start takes the line named then.
  const noWords = useBotItemCommentDraftEmpty(botItemCommentDraftKey(hostId, uid))
  const photos = useMobileNativeChatDraftInputs(uid, 'images')
  const boxEmpty = noWords && photos.length === 0
  const { sent, quick, fromBox, waitingLine } = useBotItemQuestionSteps(
    itemKey,
    view.item,
    view.events,
    sendComment,
    pending.shown,
    boxEmpty
  )
  const openAsk = view.item ? botItemOpenAsk(view.item, view.events) : null
  // A reply already on its way answers its question, before the host's read says so.
  const replying = pending.shown.some((entry) => isBotItemReplyingTo(entry, openAsk?.askId ?? null))
  const { askOpen, askShown, ...ask } = useMobileBotItemAskSlot({
    itemKey,
    ask: openAsk,
    online: online && !view.failed,
    replying,
    loaded: view.item !== null,
    host: view.item ? { item: view.item, events: view.events } : null,
    onOpenWithCard: jump.top,
    send: quick
  })
  const commentField = useRef<TextInputInstance>(null)
  // Quoting starts a comment, so the answer card folds to its strip and the box shows.
  const quoteComment = (text: string): void => {
    if (askShown) {
      ask.fold()
    }
    quoteIntoBotItemCommentDraft(botItemCommentDraftKey(hostId, uid), text)
    // In the tap itself: iOS opens the keyboard only for a focus the gesture made.
    commentField.current?.focus()
  }
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
    // Paths in the item's text open as the item's file links do, as chat's do in chat.
    <MobileNativeChatOpenFileContext value={onOpenFile}>
      <View style={styles.page}>
        {back}
        <MobileNativeChatComposerMenuHost style={styles.scroll}>
          <View style={styles.scroll}>
            <ScrollView
              ref={jump.ref}
              style={styles.scroll}
              contentContainerStyle={styles.content}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              onContentSizeChange={jump.onContentSizeChange}
              onLayout={jump.onLayout}
              onScroll={jump.onScroll}
              onScrollToTop={jump.tail.releaseFollow}
              onScrollBeginDrag={jump.tail.beginUserScroll}
              onScrollEndDrag={jump.tail.endUserDrag}
              onMomentumScrollBegin={jump.tail.beginMomentum}
              onMomentumScrollEnd={jump.tail.endMomentum}
              scrollEventThrottle={32}
            >
              <View style={styles.head}>
                <Text style={styles.title}>
                  <Text style={styles.number}>{formatBotItemNumber(item.number)} </Text>
                  {item.title}
                </Text>
                {item.description ? <MobileBotItemDescription text={item.description} /> : null}
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
                  {...(item.status === 'waiting' && item.wait
                    ? { subtitle: item.wait.text, subtitleLines: 0 }
                    : {})}
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
                sent={sent}
                asking={askOpen}
                onQuote={quoteComment}
              />
            </ScrollView>
            {/* A soft edge over the comment box: activity scrolling under it reads as more below. */}
            <MobileEdgeFade edge="bottom" color={colors.sheetSurface} />
            <MobileNativeChatFloatingControls
              showJumpToTail={jump.tail.showJumpToTail}
              onJumpToTail={jump.jumpToTail}
            />
          </View>
          <View
            style={askShown ? styles.askDock : undefined}
            onLayout={(event) => onCommentBoxHeight(event.nativeEvent.layout.height)}
          >
            <View style={askShown ? styles.askSlot : styles.hidden}>{ask.card}</View>
            <MobileNativeChatPromptStrip prompt={ask.strip} />
            {/* Kept mounted under the card, so its draft and photos stay put. */}
            <View style={askShown ? styles.hidden : undefined}>
              <MobileBotItemCommentBox
                client={client}
                item={item}
                online={online && !view.failed}
                hostName={hostName}
                // While the card holds the answer, the box is a plain comment: one place to type the answer.
                question={
                  waitingLine && !replying && !askOpen
                    ? { ...waitingLine, asker: item.owner.name ?? bot.name }
                    : null
                }
                attachTo={
                  stagesImages
                    ? botItemAttachmentTarget(item.uid)
                    : takesImages && !item.chat.gone
                      ? item.chat.id
                      : null
                }
                hostId={hostId}
                bot={bot}
                fieldRef={commentField}
                onSend={fromBox}
                showToast={showToast}
              />
            </View>
          </View>
        </MobileNativeChatComposerMenuHost>
      </View>
    </MobileNativeChatOpenFileContext>
  )
}

const styles = themedStyleSheet(() => ({
  page: { flex: 1, backgroundColor: colors.sheetSurface },
  hidden: { display: 'none' },
  // As chat caps its card: the activity stays in view and a tall card scrolls inside.
  askDock: { flexShrink: 1, minHeight: 0, maxHeight: '60%' },
  // The card's own inset is the chat's screen edge; here the page already has one, so its edge meets the groups'.
  askSlot: { flexShrink: 1, minHeight: 0, marginHorizontal: -spacing.sm },
  scroll: { flex: 1 },
  content: { gap: spacing.sm, paddingBottom: spacing.lg },
  head: { paddingHorizontal: spacing.xs, gap: spacing.xs },
  title: { fontSize: typography.titleSize, fontWeight: '600', color: colors.textPrimary },
  number: { fontWeight: '400', color: colors.textMuted, fontVariant: ['tabular-nums'] },
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
