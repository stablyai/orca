import type React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronDown, ChevronRight, Lightbulb } from '../components/icons/app-icons'
import { botGroupRowLine } from '../../../src/shared/bots/bot-sidebar-entries'
import type { Worktree, WorktreeRowView } from '../worktree/workspace-list/workspace-list-types'
import { formatTimeAgo } from '../worktree/agent-lineage/agent-row-display'
import { mobileBotRowLine, mobileBotRowLineText, mobileBotRowNeedsYou } from './mobile-bot-row-line'
import { colors, feedback, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { AgentSpinner } from '../agents/presentation/AgentSpinner'
import { MobileBotItemStatusIcon } from './items/MobileBotItemStatusIcon'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useSharedNow } from '../hooks/use-now'
import { HostContextPill } from '../worktree/row-presentation/HostContextPill'
import { MobileBotAvatar } from './MobileBotAvatar'
import { MobileBotFaceStack } from './MobileBotFaceStack'
import { MobileConnectorSourceIcon } from './MobileConnectorSourceIcon'
import type { BotRowStatus } from '../../../src/shared/bots/bot-row-status'
import type { WorktreeStatus } from '../../../src/shared/worktree/row-display/worktree-status-rollup'
import type { MobileBotAvatarSource, MobileBotGroupRowFacts } from './host-bot-row-facts'

/** The bot's home opens through the same workspace control as every other row. */
export function MobileBotHomeRow({
  item,
  view,
  isReadOnly,
  onPress,
  onLongPress,
  onToggle
}: {
  item: Worktree
  view: WorktreeRowView
  isReadOnly: boolean
  onPress: () => void
  onLongPress?: () => void
  onToggle?: () => void
}) {
  const t = useMobileTranslation()
  const now = useSharedNow(30_000)
  const bot = view.botFacts!
  // The desktop row's line, from its Chat's and threads' agent rows; waits while nothing works.
  const line = mobileBotRowLine(bot, item.agents ?? [], now)
  // The line's count, so the badge never disagrees with it; a down host's row keeps its last, greyed.
  const needsYou = mobileBotRowNeedsYou(bot.line, item.agents ?? [], now)
  // A down server's bot shows only where it runs and that computer's word: its last activity isn't live.
  const down = bot.host?.word !== undefined
  const asking = !down && line?.kind === 'needYouElsewhere'
  const lineText = line ? mobileBotRowLineText(line, now) : bot.statusLine
  // The line names who waits on an access answer, since nothing else on the row says it.
  const preview = down
    ? ''
    : asking && bot.askedForAccess
      ? `${lineText} · ${t('bots.needs.access', '{{person}} asked for access', { person: bot.askedForAccess })}`
      : lineText
  const age =
    !down && line?.kind === 'activity' && line.at !== null ? formatTimeAgo(line.at, now) : null
  // The desktop's mark before a thread's label, which leads an activity line.
  const placeSource = !down && line?.kind === 'activity' ? (line.place?.source ?? null) : null
  const count = view.lineageChildCount ?? 0
  const Chevron = view.lineageCollapsed ? ChevronRight : ChevronDown
  return (
    <MobileBotRowView
      avatar={<MobileBotRowAvatar avatar={bot.avatar} dot={down ? null : bot.dot} />}
      title={item.displayName}
      unread={item.unread}
      preview={preview}
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
          {needsYou > 0 ? <MobileBotNeedsYouCount count={needsYou} /> : null}
          {bot.upNext ? <MobileBotUpNextCount count={bot.upNext} /> : null}
          {/* A folded bot always keeps its chevron, so it can unfold before its chats are read; a
              down host's bot is its row alone. */}
          {!down && (count > 0 || bot.foldsChats || view.lineageCollapsed) && onToggle ? (
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
      age={line.at === null ? null : formatTimeAgo(line.at, now)}
      active={item.isActive}
      divider={divider}
      disabled={isReadOnly}
      onPress={onPress}
      onLongPress={onLongPress}
    />
  )
}

/** A bot's 32 pt picture with its own turn's status at the corner; a down host's bot has none. */
export function MobileBotRowAvatar({
  avatar,
  dot,
  surface
}: {
  avatar: MobileBotAvatarSource
  dot: BotRowStatus | null
  surface?: string
}) {
  return (
    <>
      <MobileBotAvatar avatar={avatar} size={32} />
      <MobileBotRowStatus dot={dot} surface={surface} />
    </>
  )
}

/** A row picture's status at its corner, ringed in the surface it sits on; none draws nothing. */
export function MobileBotRowStatus({
  dot,
  surface
}: {
  dot: WorktreeStatus | null
  /** The row's background, when it isn't the page's (a grouped panel). */
  surface?: string
}) {
  return dot && dot !== 'active' && dot !== 'done' ? (
    <View style={[styles.status, surface ? { backgroundColor: surface } : null]}>
      <AgentSpinner status={dot} />
    </View>
  ) : null
}

/** A bot's items that need you: an orange dot and the count, in the Up next count's muted style. */
export function MobileBotNeedsYouCount({ count }: { count: number }) {
  const t = useMobileTranslation()
  return (
    <View
      style={styles.upNext}
      accessible
      accessibilityRole="image"
      accessibilityLabel={t('bots.items.needYouCount', '{{count}} items need you', {
        count,
        defaultValue_one: '{{count}} item needs you'
      })}
    >
      <MobileBotItemStatusIcon status="needs_you" size={6} />
      <Text style={styles.count}>{count}</Text>
    </View>
  )
}

/** A bot's new Up next suggestions, in the fold's muted count style, as the desktop's lightbulb. */
function MobileBotUpNextCount({ count }: { count: number }) {
  const t = useMobileTranslation()
  return (
    <View
      style={styles.upNext}
      accessible
      accessibilityRole="image"
      accessibilityLabel={t('bots.upNext.newInUpNext', '{{count}} new in Suggestions', { count })}
    >
      <Lightbulb size={12} color={colors.textMuted} />
      <Text style={styles.count}>{count}</Text>
    </View>
  )
}

/** The Bots list's row, a bot's or a group's: picture, name, then its newest line and how long ago. */
export function MobileBotRowView({
  avatar,
  title,
  unread,
  preview,
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
            {preview}
          </Text>
          {age ? <Text style={styles.age}>{age}</Text> : null}
        </View>
      </View>
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
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
  status: {
    position: 'absolute',
    right: -5,
    bottom: -5,
    borderRadius: 12,
    backgroundColor: colors.bgBase,
    padding: 1
  },
  main: { flex: 1, minWidth: 0 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  title: { flex: 1, fontSize: 15, color: colors.textSecondary, fontWeight: '500' },
  unread: { color: colors.textPrimary, fontWeight: '700' },
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
  upNext: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  activity: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: 3 },
  preview: { flex: 1, fontSize: 13, color: colors.textMuted },
  previewUnread: { color: colors.textSecondary },
  previewAsking: { color: colors.agentQuestion },
  age: { fontSize: 11, color: colors.textMuted },
  active: { backgroundColor: colors.bgPanel },
  dimmed: { opacity: 0.6 },
  pressed: { opacity: feedback.pressedOpacity }
}))
