// An item's Activity on the phone, in the desktop's order and words: comments as cards (the bot's open
// question outlined with Waiting on you and Reply), and one muted line per other event.
import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import {
  AlarmClock,
  AlarmClockOff,
  Check,
  ChevronDown,
  CircleCheck,
  CircleX,
  CornerDownRight,
  Link,
  Pencil,
  Play,
  Plus
} from 'lucide-react-native'
import {
  botItemActivity,
  type BotItemActivityEntry,
  type BotItemQuestionState
} from '../../../../src/shared/bots/bot-item-activity'
import { botItemActorName } from '../../../../src/shared/bots/bot-item-actor-name'
import { botItemStatusName } from '../../../../src/shared/bots/bot-item-status-name'
import {
  BOT_ITEM_STATUSES,
  botItemCommentImages,
  type BotItem,
  type BotItemEvent
} from '../../../../src/shared/bots/bot-items'
import { stripSentImagePromptMarkers } from '../../../../src/shared/native-chat/transcript/images/native-chat-sent-image-prompt-markers'
import { MobileMarkdown } from '../../components/markdown/MobileMarkdown'
import { formatPhoneSnoozeTime } from './bot-item-snooze-time'
import { getUiIntlLocale } from '../../i18n/ui-intl-locale'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { Translate } from '../../i18n/mobile-i18n'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { MobileBotItemStatusIcon } from './MobileBotItemStatusIcon'

const ICON = 13

/** A comment's words without the [Image #N] its send wrote for its images, as desktop and chat show them. */
function commentText(data: Record<string, unknown>): string {
  return stripSentImagePromptMarkers(str(data.text), botItemCommentImages(data).length)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function timeOf(at: number): string {
  return new Intl.DateTimeFormat(getUiIntlLocale(), { hour: 'numeric', minute: '2-digit' }).format(
    at
  )
}

function fieldName(field: string, t: Translate): string {
  return field === 'doneMeans'
    ? t('bots.items.field.doneMeansLower', 'done means')
    : field === 'description'
      ? t('bots.items.field.description', 'description')
      : t('bots.items.field.title', 'title')
}

function statusWord(value: unknown, t: Translate): string {
  const status = BOT_ITEM_STATUSES.find((entry) => entry === value)
  return status ? botItemStatusName(status, t) : str(value)
}

/** "changed done means ⌄": the before and after open on tap, as on the desktop. */
function FieldChange({ by, field, change }: { by: string; field: string; change: unknown }) {
  const t = useMobileTranslation()
  const [open, setOpen] = useState(false)
  const diff: { from?: unknown; to?: unknown } =
    typeof change === 'object' && change !== null ? change : {}
  return (
    <View>
      <Pressable
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={styles.inline}
      >
        <Text style={styles.line}>
          <Text style={styles.actor}>{by}</Text>{' '}
          {t('bots.items.activity.changed', 'changed {{field}}', { field: fieldName(field, t) })}
        </Text>
        <ChevronDown
          size={12}
          color={colors.textMuted}
          style={open ? undefined : styles.chevronClosed}
        />
      </Pressable>
      {open ? (
        <View style={styles.diff}>
          {str(diff.from) ? <Text style={styles.removed}>{str(diff.from)}</Text> : null}
          {str(diff.to) ? <Text style={styles.added}>{str(diff.to)}</Text> : null}
        </View>
      ) : null}
    </View>
  )
}

function EventLine({ event, item }: { event: BotItemEvent; item: BotItem }) {
  const t = useMobileTranslation()
  const by = botItemActorName(event, item, t)
  const { data } = event
  switch (event.kind) {
    case 'commented':
      return <Text style={styles.line}>{commentText(data)}</Text>
    case 'edited': {
      const fields = typeof data.fields === 'object' && data.fields !== null ? data.fields : {}
      return (
        <>
          {Object.entries(fields).map(([field, change]) => (
            <FieldChange key={field} by={by} field={field} change={change} />
          ))}
        </>
      )
    }
    case 'status': {
      const note = str(data.note)
      const closed = (value: unknown) => value === 'done' || value === 'canceled'
      const reopened = closed(data.from) && !closed(data.to)
      return (
        <Text style={styles.line}>
          <Text style={styles.actor}>{by}</Text>{' '}
          {data.to === 'done'
            ? t('bots.items.activity.closed', 'marked this done')
            : data.to === 'canceled'
              ? t('bots.items.activity.canceled', 'canceled this')
              : reopened
                ? t('bots.items.activity.reopened', 'reopened this')
                : t('bots.items.activity.moved', 'moved this to')}
          {closed(data.to) || reopened ? null : (
            <>
              {' '}
              <Text style={styles.actor}>{statusWord(data.to, t)}</Text>
            </>
          )}
          {note ? `: ${note}` : null}
        </Text>
      )
    }
    case 'made':
      return (
        <Text style={styles.line}>
          <Text style={styles.actor}>{by}</Text>{' '}
          {data.status === 'needs_you'
            ? t('bots.items.activity.madeNeedsYou', 'added this item as Needs you')
            : t('bots.items.activity.made', 'added this item')}
        </Text>
      )
    case 'linked':
      return (
        <Text style={styles.line}>
          <Text style={styles.actor}>{by}</Text>{' '}
          {t('bots.items.activity.linked', 'linked {{links}}', {
            links: Array.isArray(data.links) ? data.links.join(', ') : ''
          })}
        </Text>
      )
    case 'snoozed':
      return (
        <Text style={styles.line}>
          <Text style={styles.actor}>{by}</Text>{' '}
          {typeof data.until === 'number'
            ? t('bots.items.activity.snoozed', 'snoozed this until {{when}}', {
                when: formatPhoneSnoozeTime(data.until, event.at)
              })
            : t('bots.items.activity.snoozedBare', 'snoozed this')}
        </Text>
      )
    case 'unsnoozed':
      // Ended early by a new question, a close or the owner's own move: the next line says which.
      return data.early ? (
        <Text style={styles.line}>
          {t('bots.items.activity.snoozeEnded', 'Back from snooze early')}
        </Text>
      ) : (
        <Text style={styles.line}>
          <Text style={styles.actor}>{by}</Text>{' '}
          {t('bots.items.activity.unsnoozed', 'unsnoozed this')}
        </Text>
      )
  }
}

function WorkerLine({ entry }: { entry: Extract<BotItemActivityEntry, { kind: 'worker' }> }) {
  const t = useMobileTranslation()
  const title = <Text style={styles.actor}>{entry.link.title ?? entry.link.ref}</Text>
  if (entry.phase === 'started') {
    return (
      <Text style={styles.line}>
        {t('bots.items.activity.workerStarted', 'Worker started:')} {title}
      </Text>
    )
  }
  const failed = entry.link.state === 'failed' || entry.link.state === 'stopped'
  return (
    <View>
      <Text style={styles.line}>
        {failed
          ? t('bots.items.activity.workerFailed', 'Worker stopped:')
          : t('bots.items.activity.workerFinished', 'Worker finished:')}{' '}
        {title}
      </Text>
      {entry.link.report ? (
        <Text style={styles.line} numberOfLines={2}>
          {entry.link.report.subject}
        </Text>
      ) : null}
    </View>
  )
}

function EntryIcon({ entry }: { entry: Exclude<BotItemActivityEntry, { kind: 'comment' }> }) {
  if (entry.kind === 'worker') {
    if (entry.phase === 'started') {
      return <Play size={ICON} color={colors.textMuted} />
    }
    return entry.link.state === 'failed' || entry.link.state === 'stopped' ? (
      <CircleX size={ICON} color={colors.statusRed} />
    ) : (
      <CircleCheck size={ICON} color={colors.statusGreen} />
    )
  }
  const { event } = entry
  switch (event.kind) {
    case 'made':
      return <Plus size={ICON} color={colors.textMuted} />
    case 'edited':
      return <Pencil size={ICON} color={colors.textMuted} />
    case 'linked':
      return <Link size={ICON} color={colors.textMuted} />
    case 'snoozed':
      return <AlarmClock size={ICON} color={colors.textMuted} />
    case 'unsnoozed':
      return <AlarmClockOff size={ICON} color={colors.textMuted} />
    case 'status': {
      const status = BOT_ITEM_STATUSES.find((value) => value === event.data.to)
      return status ? <MobileBotItemStatusIcon status={status} /> : null
    }
    case 'commented':
      return null
  }
}

function CommentCard({
  item,
  event,
  question,
  onReply
}: {
  item: BotItem
  event: BotItemEvent
  question: BotItemQuestionState | null
  onReply: () => void
}) {
  const t = useMobileTranslation()
  const mine = event.actor.kind === 'owner'
  const text = commentText(event.data)
  return (
    <View style={[styles.card, mine && styles.cardMine, question === 'open' && styles.cardOpen]}>
      {question === 'open' ? (
        <View style={styles.cardTop}>
          <MobileBotItemStatusIcon status="needs_you" />
          <Text style={styles.waiting}>
            {t('bots.items.activity.waitingOnYou', 'Waiting on you')}
          </Text>
          <View style={styles.spacer} />
          <Pressable onPress={onReply} accessibilityRole="button" hitSlop={8} style={styles.inline}>
            <CornerDownRight size={12} color={colors.textPrimary} />
            <Text style={styles.reply}>{t('bots.items.activity.reply', 'Reply')}</Text>
          </Pressable>
        </View>
      ) : null}
      <View style={styles.cardHead}>
        <Text style={styles.author}>{botItemActorName(event, item, t)}</Text>
        {question ? (
          <Text style={styles.meta} numberOfLines={1}>
            {question === 'open'
              ? t('bots.items.activity.asksYou', 'asks you')
              : t('bots.items.activity.askedYou', 'asked you')}
          </Text>
        ) : null}
        <View style={styles.spacer} />
        {question === 'answered' ? (
          <View style={styles.inline}>
            <Check size={11} color={colors.textMuted} />
            <Text style={styles.meta}>{t('bots.items.activity.answered', 'Answered')}</Text>
          </View>
        ) : null}
        <Text style={styles.meta}>{timeOf(event.at)}</Text>
      </View>
      <MobileMarkdown content={text} />
    </View>
  )
}

export function MobileBotItemActivity({
  item,
  events,
  onReply
}: {
  item: BotItem
  events: readonly BotItemEvent[]
  onReply: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const entries = botItemActivity(item, events)
  return (
    <View>
      {entries.map((entry) =>
        entry.kind === 'comment' ? (
          <CommentCard
            key={entry.key}
            item={item}
            event={entry.event}
            question={entry.question}
            onReply={onReply}
          />
        ) : (
          <View key={entry.key} style={styles.event}>
            <View style={styles.eventIcon}>
              <EntryIcon entry={entry} />
            </View>
            <View style={styles.eventBody}>
              {entry.kind === 'worker' ? (
                <WorkerLine entry={entry} />
              ) : (
                <EventLine event={entry.event} item={item} />
              )}
            </View>
            <Text style={styles.meta}>{timeOf(entry.at)}</Text>
          </View>
        )
      )}
      {entries.some((entry) => entry.kind === 'comment') ? null : (
        <Text style={[styles.line, styles.none]}>
          {t('bots.items.activity.noComments', 'No comments yet.')}
        </Text>
      )}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  event: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingVertical: 6,
    paddingHorizontal: spacing.xs
  },
  eventIcon: { width: 16, height: 18, alignItems: 'center', justifyContent: 'center' },
  eventBody: { flex: 1, minWidth: 0 },
  line: { fontSize: 13, lineHeight: 18, color: colors.textMuted },
  none: { paddingHorizontal: spacing.xs, paddingTop: spacing.xs },
  actor: { fontWeight: '500', color: colors.textSecondary },
  inline: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  chevronClosed: { transform: [{ rotate: '-90deg' }] },
  diff: {
    marginTop: 2,
    paddingLeft: spacing.sm,
    borderLeftWidth: 2,
    borderLeftColor: colors.borderSubtle,
    gap: 2
  },
  removed: {
    fontSize: 13,
    lineHeight: 18,
    color: colors.textMuted,
    textDecorationLine: 'line-through'
  },
  added: { fontSize: 13, lineHeight: 18, color: colors.textPrimary },
  card: {
    marginVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    borderRadius: radii.surface,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.sheetGroup
  },
  cardMine: { backgroundColor: colors.bgRaised },
  cardOpen: { borderColor: colors.textMuted },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingBottom: spacing.sm,
    marginBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  waiting: { fontSize: typography.metaSize, fontWeight: '500', color: colors.textPrimary },
  reply: { fontSize: 13, fontWeight: '500', color: colors.textPrimary },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.xs
  },
  author: { fontSize: 13, fontWeight: '600', color: colors.textPrimary },
  meta: { fontSize: typography.metaSize, color: colors.textMuted, fontVariant: ['tabular-nums'] },
  spacer: { flex: 1 }
}))
