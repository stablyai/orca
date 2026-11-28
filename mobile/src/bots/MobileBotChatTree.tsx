// Activity's Chats on the phone: the desktop's tree, each chat with its workers one level down.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ChevronDown } from 'lucide-react-native'
import { DisclosureChevron } from '../components/list/DisclosureChevron'
import { MobileSearchField } from '../components/controls/MobileSearchField'
import { ListGroup, ListRow, SectionHeader } from '../components/list/ListGroup'
import { useNow } from '../hooks/use-now'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { spacing } from '../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
import { useMobileColors } from '../theme/use-mobile-color-scheme'
import { formatTimeAgo } from '../worktree/agent-lineage/agent-row-display'
import {
  CHAT_TREE_CAPS,
  botOwnChatTree,
  chatFoldCounts,
  chatFoldSummary,
  type BotChatTreeChat,
  type BotChatTreeWorker
} from '../../../src/shared/bots/bot-chat-tree'
import {
  BOT_CHAT_TREE_FIRST_SHOWN,
  botChatIsOpen,
  botChatListView,
  botChatPlace,
  botChatTreeSlice,
  botChatTreeStepIsPartial,
  nextFinishedStep,
  type BotChatSearchHit,
  type BotChatTreeShown
} from '../../../src/shared/bots/bot-chat-tree-view'
import { setBotChatFold, useBotChatFold } from './bot-chat-fold-store'
import {
  createBotChatSearchHook,
  type BotChatSearchAsk
} from '../../../src/shared/bots/use-bot-chat-search'
import { MobileBotTextButton } from './MobileBotTextButton'
import { MobileBotWorkerRow } from './MobileBotWorkerRow'
import { ChatLeading, useMobileBotChatLabel } from './MobileBotChatLeading'
import { MobileBotChatSearchNotes } from './MobileBotChatSearchNotes'
import { MobileBotChatMenu } from './MobileBotChatDelete'

const useBotChatSearch = createBotChatSearchHook({ useCallback, useEffect, useMemo, useState })

export type BotChatTreeActions = {
  openChat: (chat: BotChatTreeChat) => void
  openWorker: (worker: BotChatTreeWorker) => void
  /** Asks, then deletes the chat; absent where the host can't. */
  deleteChat?: (chat: BotChatTreeChat) => void
}

type TreeBot = { id: string; name: string }

function useChatLine(bot: TreeBot, chat: BotChatTreeChat, folded: boolean): string {
  const t = useMobileTranslation()
  if (chat.live === 'replying') {
    return t('bots.chats.replying', 'Replying…')
  }
  const place = botChatPlace(chat)
  if (chat.live === 'needs-you') {
    const waiting = t('bots.chats.waiting', 'Waiting for you')
    return place ? `${place} · ${waiting}` : waiting
  }
  const counts = folded ? chatFoldCounts(chat) : null
  if (counts) {
    return chatFoldSummary(t, counts)
  }
  const preview =
    chat.preview ??
    (chat.origin === 'home'
      ? t('bots.chats.sayHi', 'Say hi to {{name}}', { name: bot.name })
      : null)
  return [place, chat.closed ? t('bots.chats.closedShort', 'closed') : null, preview]
    .filter(Boolean)
    .join(' · ')
}

function StepLink({ label, onPress }: { label: string; onPress: () => void }) {
  const styles = useThemedStyles(stylesSheet)
  return (
    <View style={styles.step}>
      <MobileBotTextButton label={label} onPress={onPress} />
    </View>
  )
}

function ChatGroup({
  bot,
  hostKey,
  chat,
  matches,
  loadMore,
  actions
}: {
  bot: TreeBot
  hostKey: string
  chat: BotChatTreeChat
  matches: ReadonlySet<string> | null
  loadMore: (chatId: string) => void
  actions: BotChatTreeActions
}) {
  const t = useMobileTranslation()
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const fold = useBotChatFold(hostKey, bot.id, chat.chatId)
  const [shown, setShown] = useState<BotChatTreeShown>(BOT_CHAT_TREE_FIRST_SHOWN)
  const hasWorkers = chat.runningTotal + chat.finishedTotal > 0
  const open = botChatIsOpen(chat, fold, matches !== null)
  const slice = botChatTreeSlice(chat, shown, matches)
  const now = useNow(60_000, chat.lastActiveAt > 0)
  const title =
    chat.origin === 'home'
      ? t('bots.chats.home', 'Home Chat')
      : chat.title || t('bots.chats.untitled', 'New chat')
  const label = useMobileBotChatLabel(chat, title)
  // A terminal run with no workspace has nothing the phone can open.
  const unopenable = chat.run !== undefined && !chat.run.worktreeId
  const chatLine = useChatLine(bot, chat, hasWorkers && !open)
  const line = unopenable
    ? t(
        'bots.chats.terminalRunDesktopOnly',
        'Terminal run · open it in Automations on the computer'
      )
    : chatLine
  const showEarlier = () => {
    const next = nextFinishedStep(chat, shown.finished)
    if (next.read) {
      loadMore(chat.chatId)
    }
    setShown({ ...shown, finished: next.shown })
  }
  const worker = (each: BotChatTreeWorker) => (
    <MobileBotWorkerRow
      key={each.key}
      bot={bot}
      worker={each}
      onOpen={each.worktreeId ? () => actions.openWorker(each) : undefined}
    />
  )
  const openRow = () => openChat(chat, actions)
  return (
    <>
      <MobileBotChatMenu chat={chat} onOpen={openRow} onDelete={actions.deleteChat}>
        {(onLongPress) => (
          <ListRow
            title={title}
            subtitle={line || undefined}
            leading={<ChatLeading chat={chat} />}
            strong={chat.unread}
            value={chat.lastActiveAt > 0 ? formatTimeAgo(chat.lastActiveAt, now, t) : undefined}
            accessory={
              <>
                {chat.unseen ? (
                  <Text style={styles.newTag}>{t('bots.chats.newTag', 'New')}</Text>
                ) : null}
                {hasWorkers && !matches ? (
                  <Pressable
                    hitSlop={10}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: open }}
                    accessibilityLabel={
                      open
                        ? t('bots.chats.fold', 'Fold {{name}}', { name: title })
                        : t('bots.chats.unfold', 'Unfold {{name}}', { name: title })
                    }
                    onPress={() =>
                      setBotChatFold(hostKey, bot.id, chat.chatId, open ? 'folded' : 'open')
                    }
                  >
                    <DisclosureChevron expanded={open} collapsedDeg={-90} expandedDeg={0}>
                      <ChevronDown size={16} color={colors.textMuted} />
                    </DisclosureChevron>
                  </Pressable>
                ) : null}
              </>
            }
            onPress={unopenable ? undefined : openRow}
            onLongPress={onLongPress}
            accessibilityLabel={
              chat.unread ? `${label}, ${t('bots.chats.unread', 'Unread')}` : label
            }
          />
        )}
      </MobileBotChatMenu>
      {open ? slice.running.map(worker) : null}
      {open && slice.moreRunning > 0 ? (
        <StepLink
          label={
            botChatTreeStepIsPartial(slice.moreRunning)
              ? t('bots.chats.moreRunningStep', 'Show 8 more · {{count}} more running', {
                  count: slice.moreRunning
                })
              : t('bots.chats.moreRunning', 'Show {{count}} more running', {
                  count: slice.moreRunning
                })
          }
          onPress={() => setShown({ ...shown, running: shown.running + CHAT_TREE_CAPS.step })}
        />
      ) : null}
      {open ? slice.finished.map(worker) : null}
      {open && slice.earlier > 0 ? (
        <StepLink
          label={
            botChatTreeStepIsPartial(slice.earlier)
              ? t('bots.chats.earlierStep', 'Show 8 more · {{count}} earlier', {
                  count: slice.earlier
                })
              : t('bots.chats.earlier', 'Show {{count}} earlier', { count: slice.earlier })
          }
          onPress={showEarlier}
        />
      ) : null}
      {open && slice.stepped ? (
        <StepLink
          label={t('bots.chats.showFewer', 'Show fewer')}
          onPress={() => setShown(BOT_CHAT_TREE_FIRST_SHOWN)}
        />
      ) : null}
    </>
  )
}

/** A chat opens as the desktop's do; a terminal run has no chat, so its terminal opens, as a worker's does. */
function openChat(chat: BotChatTreeChat, actions: BotChatTreeActions) {
  const { run } = chat
  if (!run) {
    actions.openChat(chat)
  } else if (run.worktreeId) {
    actions.openWorker({
      key: chat.chatId,
      title: chat.title,
      state: chat.live === 'idle' ? 'done' : 'running',
      startedAt: chat.lastActiveAt,
      worktreeId: run.worktreeId,
      ...(run.paneKey ? { paneKey: run.paneKey } : {})
    })
  }
}

/** The bot's chats, Home first, each opening as the desktop's do. */
export function MobileBotChatTree({
  bot,
  hostKey,
  chats: treeChats,
  loadMore,
  search,
  actions
}: {
  bot: TreeBot
  /** The phone's key for the bot's host; folds are kept under it. */
  hostKey: string
  /** In tree order. */
  chats: readonly BotChatTreeChat[]
  loadMore: (chatId: string) => void
  /** Asks the bot's host to search every chat and worker. */
  search: BotChatSearchAsk
  actions: BotChatTreeActions
}) {
  const t = useMobileTranslation()
  const styles = useThemedStyles(stylesSheet)
  // As on the desktop: a group room session's row stays out, its workers under Home Chat.
  const chats = useMemo(
    () => botOwnChatTree({ chats: [...treeChats], workspaceChats: {} }).chats,
    [treeChats]
  )
  const [steps, setSteps] = useState(0)
  const [query, setQuery] = useState('')
  const searchState = useBotChatSearch(search, chats, query)
  const view = botChatListView(chats, { steps, query, search: searchState })
  const group = ({ chat, matches }: BotChatSearchHit) => (
    <ChatGroup
      key={chat.chatId}
      bot={bot}
      hostKey={hostKey}
      chat={chat}
      matches={matches}
      loadMore={loadMore}
      actions={actions}
    />
  )
  return (
    <View>
      <SectionHeader
        title={t('bots.chats.title', 'Chats')}
        trailing={<Text style={styles.count}>{chats.length}</Text>}
      />
      {view.onlyHome ? null : (
        <MobileSearchField
          value={query}
          onChangeText={setQuery}
          placeholder={t('bots.chats.search', 'Search chats and workers')}
          style={styles.search}
        />
      )}
      {view.found.length > 0 ? <ListGroup>{view.found.map(group)}</ListGroup> : null}
      <MobileBotChatSearchNotes view={view} retry={searchState?.retry} />
      {view.onlyHome ? (
        <Text style={styles.note}>
          {t(
            'bots.chats.empty',
            'Side chats, Slack and Linear threads and automation runs show up here, each with the workers it starts.'
          )}
        </Text>
      ) : null}
      {view.older > 0 || steps > 0 ? (
        <View style={styles.links}>
          {view.older > 0 ? (
            <MobileBotTextButton
              label={
                botChatTreeStepIsPartial(view.older)
                  ? t('bots.chats.olderStep', 'Show 8 more · {{count}} older', {
                      count: view.older
                    })
                  : t('bots.chats.older', 'Show {{count}} older', { count: view.older })
              }
              onPress={() => setSteps(steps + 1)}
            />
          ) : null}
          {steps > 0 ? (
            <MobileBotTextButton
              label={t('bots.chats.showFewer', 'Show fewer')}
              onPress={() => setSteps(0)}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  step: { paddingLeft: spacing.xl + spacing.md, paddingVertical: 2 },
  count: { fontSize: 13, color: colors.textMuted },
  search: { marginBottom: spacing.sm },
  note: {
    fontSize: 12,
    color: colors.textMuted,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm
  },
  newTag: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textPrimary,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: 4,
    paddingHorizontal: 4,
    marginLeft: 6
  },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, paddingTop: spacing.xs }
}))
