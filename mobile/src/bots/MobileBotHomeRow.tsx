import type React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronDown, ChevronRight } from 'lucide-react-native'
import { botGroupRowLine } from '../../../src/shared/bots/bot-sidebar-entries'
import {
  splitBotSearchText,
  type BotSearchRange
} from '../../../src/shared/bots/bot-sidebar-search'
import type { Worktree, WorktreeRowView } from '../worktree/workspace-list/workspace-list-types'
import { formatTimeAgo } from '../worktree/agent-lineage/agent-row-display'
import {
  mobileBotRowLimitText,
  mobileBotRowLine,
  mobileBotRowLineText,
  mobileBotRowNeedsYou
} from './mobile-bot-row-line'
import { useMobileBotUsageLimitStop } from './use-mobile-bot-usage-limit-stop'
import { feedback, spacing } from '../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
import { AgentSpinner } from '../agents/presentation/AgentSpinner'
import { intlLocaleFor } from '../i18n/ui-intl-locale'
import { useMobileTranslation, useMobileUiLocale } from '../i18n/use-mobile-translation'
import { useSharedNow } from '../hooks/use-now'
import { HostContextPill } from '../worktree/row-presentation/HostContextPill'
import { MobileBotFaceStack } from './MobileBotFaceStack'
import { MobileConnectorSourceIcon } from './MobileConnectorSourceIcon'
import {
  MobileBotNeedsYouCount,
  MobileBotRowAvatar,
  MobileBotRowStatus,
  MobileBotUpNextCount
} from './MobileBotRowBadges'
import type { MobileBotGroupRowFacts } from './host-bot-row-facts'
import { useMobileColors } from '../theme/use-mobile-color-scheme'

/** The bot's home opens through the same workspace control as every other row. */
export function MobileBotHomeRow({
  item,
  view,
  isReadOnly,
  pairedHostId,
  onPress,
  onLongPress,
  onToggle
}: {
  item: Worktree
  view: WorktreeRowView
  isReadOnly: boolean
  /** The paired computer, whose status feed says which of its sessions stopped on a usage limit. */
  pairedHostId: string | null
  onPress: () => void
  onLongPress?: () => void
  onToggle?: () => void
}) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const intlLocale = intlLocaleFor(useMobileUiLocale())
  const now = useSharedNow(30_000)
  const bot = view.botFacts!
  // The desktop row's line, from its Chat's and threads' agent rows; waits while nothing works. A
  // search that found the bot by what it's for shows that in its place.
  const line = bot.searchPurpose ? null : mobileBotRowLine(bot, item.agents ?? [], now, t)
  // The line's count, so the badge never disagrees with it; a down host's row keeps its last, greyed.
  const needsYou = mobileBotRowNeedsYou(bot.line, item.agents ?? [], now)
  // A down server's bot shows only where it runs and that computer's word: its last activity isn't live.
  const down = bot.host?.word !== undefined
  const asking = !down && line?.kind === 'needYouElsewhere'
  // A server's sessions aren't on its paired computer's feed; a search's purpose line keeps its place.
  const feedHost = down || bot.host || bot.searchPurpose ? null : pairedHostId
  const stop = useMobileBotUsageLimitStop(feedHost, bot.workspaceIds, now)
  const limitText = mobileBotRowLimitText(
    stop,
    line,
    { ...bot.line, dot: bot.dot },
    now,
    t,
    intlLocale
  )
  const lineText =
    limitText ??
    (line ? mobileBotRowLineText(line, now, t) : (bot.searchPurpose?.text ?? bot.statusLine))
  // The line names who waits on an access answer, since nothing else on the row says it.
  const preview = down
    ? ''
    : asking && bot.askedForAccess
      ? `${lineText} · ${t('bots.needs.access', '{{person}} asked for access', { person: bot.askedForAccess })}`
      : lineText
  const age =
    !down && !limitText && line?.kind === 'activity' && line.at !== null
      ? formatTimeAgo(line.at, now, t)
      : null
  // The desktop's mark before a thread's label, which leads an activity line.
  const placeSource =
    !down && !limitText && line?.kind === 'activity' ? (line.place?.source ?? null) : null
  const count = view.lineageChildCount ?? 0
  const Chevron = view.lineageCollapsed ? ChevronRight : ChevronDown
  return (
    <MobileBotRowView
      avatar={
        <MobileBotRowAvatar
          avatar={bot.avatar}
          dot={down ? null : bot.dot}
          stopped={!down && limitText !== null}
        />
      }
      title={item.displayName}
      unread={item.unread}
      preview={preview}
      previewBold={down ? undefined : bot.searchPurpose?.ranges}
      asking={asking}
      previewLeading={
        <>
          {bot.host ? (
            <HostContextPill
              hostId={bot.host.id}
              label={bot.host.label}
              healthLabel={bot.host.word}
            />
          ) : null}
          {placeSource ? <MobileConnectorSourceIcon source={placeSource} size={12} /> : null}
        </>
      }
      age={age}
      active={item.isActive}
      dimmed={view.dimmed}
      divider={view.botDivider === true}
      disabled={isReadOnly}
      onPress={onPress}
      onLongPress={onLongPress}
      titleTrailing={
        <>
          {/* The line already says "N need you": the count once. */}
          {needsYou > 0 && !(asking && limitText === null) ? (
            <MobileBotNeedsYouCount count={needsYou} />
          ) : null}
          {bot.upNext ? <MobileBotUpNextCount count={bot.upNext} /> : null}
          {/* Its live chats list under it unfolded, so only a folded bot, or one whose chats this host
              can't list, keeps a chevron; a down host's bot is its row alone. */}
          {!down && (view.lineageCollapsed || (!bot.listsChats && count > 0)) && onToggle ? (
            <Pressable
              onPress={(event) => {
                event.stopPropagation()
                onToggle()
              }}
              accessibilityRole="button"
              accessibilityLabel={
                view.lineageCollapsed
                  ? t('bots.workspaces.show', 'Show {{name}}’s workspaces', {
                      name: item.displayName
                    })
                  : t('bots.workspaces.hide', 'Hide {{name}}’s workspaces', {
                      name: item.displayName
                    })
              }
              accessibilityState={{ expanded: !view.lineageCollapsed }}
              aria-expanded={!view.lineageCollapsed}
              style={styles.fold}
            >
              {view.lineageCollapsed ? (
                // The status of its most urgent live workspace, then how many it has in all.
                <>
                  {bot.foldLive ? <AgentSpinner status={bot.foldLive} /> : null}
                  {count > 0 ? <Text style={styles.count}>{count}</Text> : null}
                </>
              ) : null}
              <Chevron size={14} color={colors.textMuted} />
            </Pressable>
          ) : null}
        </>
      }
    />
  )
}

/** A group in the Bots list: its members' faces, then the room's newest post. */
export function MobileBotGroupRow({
  item,
  facts,
  isReadOnly,
  divider = false,
  onPress,
  onLongPress
}: {
  item: Worktree
  facts: MobileBotGroupRowFacts
  isReadOnly: boolean
  divider?: boolean
  onPress: () => void
  onLongPress?: () => void
}) {
  const t = useMobileTranslation()
  const now = useSharedNow(30_000)
  const line = botGroupRowLine(facts.group, facts.members, t('bots.groups.you', 'You'))
  return (
    <MobileBotRowView
      avatar={
        <>
          <MobileBotFaceStack faces={facts.members} />
          <MobileBotRowStatus dot={facts.dot} />
        </>
      }
      title={item.displayName}
      unread={item.unread}
      preview={line.text}
      age={line.at === null ? null : formatTimeAgo(line.at, now, t)}
      active={item.isActive}
      divider={divider}
      disabled={isReadOnly}
      onPress={onPress}
      onLongPress={onLongPress}
    />
  )
}

/** The Bots list's row, a bot's or a group's: picture, name, then its newest line and how long ago. */
export function MobileBotRowView({
  avatar,
  title,
  unread,
  preview,
  previewBold,
  asking = false,
  previewLeading = null,
  age,
  active = false,
  dimmed = false,
  divider = false,
  disabled = false,
  onPress,
  onLongPress,
  titleTrailing = null
}: {
  avatar: React.ReactNode
  title: string
  unread: boolean
  preview: string
  /** Search's matched words in the preview, drawn bold. */
  previewBold?: readonly BotSearchRange[]
  /** The line says what waits on the owner, in the asking colour. */
  asking?: boolean
  /** Drawn before the preview, e.g. a server bot's computer. */
  previewLeading?: React.ReactNode
  age: string | null
  active?: boolean
  dimmed?: boolean
  /** A hairline above it, from its text's edge: the Bots list's rows draw their own, since a
   *  bot's chats and lines under it have none. */
  divider?: boolean
  disabled?: boolean
  onPress: () => void
  onLongPress?: () => void
  titleTrailing?: React.ReactNode
}) {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={400}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={[title, preview, unread ? t('bots.chats.unread', 'Unread') : '']
        .filter(Boolean)
        .join(', ')}
      style={({ pressed }) => [
        styles.row,
        active && styles.active,
        dimmed && styles.dimmed,
        pressed && styles.pressed
      ]}
    >
      {divider ? <View style={styles.divider} /> : null}
      <View style={styles.avatar}>{avatar}</View>
      <View style={styles.main}>
        <View style={styles.titleRow}>
          <Text numberOfLines={1} style={[styles.title, unread && styles.unread]}>
            {title}
          </Text>
          {titleTrailing}
        </View>
        <View style={styles.activity}>
          {previewLeading}
          <Text
            numberOfLines={1}
            style={[styles.preview, unread && styles.previewUnread, asking && styles.previewAsking]}
          >
            {previewBold ? <BoldMatches text={preview} ranges={previewBold} /> : preview}
          </Text>
          {age ? <Text style={styles.age}>{age}</Text> : null}
        </View>
      </View>
    </Pressable>
  )
}

/** A search's matched words drawn bold within the line, keyed by where each starts. */
function BoldMatches({ text, ranges }: { text: string; ranges: readonly BotSearchRange[] }) {
  const styles = useThemedStyles(stylesSheet)
  const parts = splitBotSearchText(text, ranges)
  const starts = parts.map((_, at) =>
    parts.slice(0, at).reduce((length, part) => length + part.text.length, 0)
  )
  return (
    <>
      {parts.map((part, at) =>
        part.marked ? (
          <Text key={starts[at]} style={styles.previewMatch}>
            {part.text}
          </Text>
        ) : (
          part.text
        )
      )}
    </>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    minHeight: 64
  },
  avatar: { position: 'relative', flexShrink: 0 },
  divider: {
    position: 'absolute',
    top: 0,
    right: 0,
    // The title's edge: the row's padding, the 32 pt picture and its gap.
    left: spacing.lg + 32 + spacing.md,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle
  },
  main: { flex: 1, minWidth: 0 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  title: { flex: 1, fontSize: 15, color: colors.textPrimary, fontWeight: '500' },
  unread: { fontWeight: '700' },
  fold: {
    minWidth: 44,
    minHeight: 44,
    marginVertical: -12,
    flexDirection: 'row',
    gap: spacing.xs,
    alignItems: 'center',
    justifyContent: 'flex-end'
  },
  count: { fontSize: 13, color: colors.textMuted },
  activity: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: 3 },
  preview: { flex: 1, fontSize: 13, color: colors.textMuted },
  previewUnread: { color: colors.textSecondary },
  previewAsking: { color: colors.agentQuestion },
  previewMatch: { fontWeight: '600', color: colors.textPrimary },
  age: { fontSize: 11, color: colors.textMuted },
  active: { backgroundColor: colors.bgPanel },
  dimmed: { opacity: 0.6 },
  pressed: { opacity: feedback.pressedOpacity }
}))
