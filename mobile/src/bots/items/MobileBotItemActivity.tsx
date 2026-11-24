// An item's Activity on the phone, in the desktop's order and words: comments as cards (an agent's
// question with its question footer and quick replies), and one muted line per other event; comments
// sent from the box that the host's read doesn't show yet come last, as sent. A reply's quote shows its
// question: scrolled to the middle and briefly lit, as the desktop's comment box does (a tap has no focus ring).
import { useCallback, useRef, useState } from 'react'
import { Pressable, Text, View, type HostInstance } from 'react-native'
import {
  AlarmClock,
  AlarmClockOff,
  ChevronDown,
  CircleCheck,
  CircleX,
  Link,
  Pencil,
  Play,
  Plus
} from '../../components/icons/app-icons'
import {
  botItemActivity,
  botItemLiveAskKey,
  botItemWaitEntryKey,
  botItemWorkerStopReason,
  type BotItemActivityEntry
} from '../../../../src/shared/bots/bot-item-activity'
import { botItemActorName } from '../../../../src/shared/bots/bot-item-actor-name'
import { botItemStatusName } from '../../../../src/shared/bots/bot-item-status-name'
import {
  BOT_ITEM_STATUSES,
  type BotItem,
  type BotItemEvent
} from '../../../../src/shared/bots/bot-items'
import type { BotItemPendingComments } from '../../../../src/shared/bots/bot-item-pending-comments'
import type { BotItemQuickReplyActions } from '../../../../src/shared/bots/use-bot-item-question-steps'
import {
  mobileBotItemCommentWords,
  type MobileBotItemAttachmentSource
} from './MobileBotItemCommentAttachments'
import { formatPhoneSnoozeTime } from './bot-item-snooze-time'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { Translate } from '../../i18n/mobile-i18n'
import { colors, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useReducedMotionEnabled } from '../../platform/accessibility/use-reduced-motion'
import { MobileBotItemCommentCard } from './MobileBotItemCommentCard'
import { MobileBotItemStatusIcon } from './MobileBotItemStatusIcon'
import { MobileBotItemWaitCard } from './MobileBotItemWaitCard'
import { useMobileMessageTime } from '../../session/native-chat/transcript/messages/use-mobile-message-time'

const ICON = 13

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
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
      return <Text style={styles.line}>{mobileBotItemCommentWords(data)}</Text>
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
  const reason = botItemWorkerStopReason(entry.link)
  return (
    <View>
      <Text style={styles.line}>
        {failed
          ? t('bots.items.activity.workerFailed', 'Worker stopped:')
          : t('bots.items.activity.workerFinished', 'Worker finished:')}{' '}
        {title}
        {reason ? ` - ${reason}` : null}
      </Text>
      {entry.link.report ? (
        <Text style={styles.line} numberOfLines={2}>
          {entry.link.report.subject}
        </Text>
      ) : null}
    </View>
  )
}

type LineEntry = Exclude<BotItemActivityEntry, { kind: 'comment' }>

function EntryIcon({ entry }: { entry: LineEntry }) {
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

export function MobileBotItemActivity({
  item,
  events,
  attachments,
  pending,
  onReveal,
  itemScope,
  quickReplies,
  repliesDisabled
}: {
  item: BotItem
  events: readonly BotItemEvent[]
  /** Comments sent from the box that the item's read doesn't show yet: last, as sent. */
  pending: Pick<BotItemPendingComments, 'shown' | 'retry' | 'discard'>
  attachments: MobileBotItemAttachmentSource
  /** Scrolls the page to a span measured in the window. */
  onReveal: (y: number, height: number, animated: boolean) => void
  /** The item on its host, which an ask's held answers are kept under. */
  itemScope: string
  /** What the waiting question's quick replies do. */
  quickReplies: BotItemQuickReplyActions
  /** The host can't take a comment now (offline). */
  repliesDisabled: boolean
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const time = useMobileMessageTime()
  const still = useReducedMotionEnabled() === true
  const cards = useRef(new Map<string, HostInstance>())
  const [flash, setFlash] = useState<{ id: string; at: number } | null>(null)
  const endFlash = useCallback(() => setFlash(null), [])
  const entries = botItemActivity(item, events)
  // Its move shows last, as its card, while the item waits.
  const waitKey = botItemWaitEntryKey(item, entries)
  const liveAsk = botItemLiveAskKey(entries)
  const comments = new Set(
    entries.flatMap((entry) => (entry.kind === 'comment' ? [entry.key] : []))
  )
  // Null while the question isn't in the Activity read so far.
  const showQuestion = (id: string | undefined): (() => void) | null =>
    id && comments.has(id)
      ? () => {
          // Measured now: on the web, layout events miss a card moved by Show more or Show earlier.
          cards.current.get(id)?.measureInWindow((_x, y, _width, height) => {
            onReveal(y, height, !still)
            setFlash({ id, at: Date.now() })
          })
        }
      : null
  // A reply already sent answers the question, before the host's read says so.
  const answered = pending.shown.some(({ failed }) => !failed)
  return (
    <View>
      {entries.map((entry) =>
        // Its wait shows last, as its card; an answer reads on its question's lines.
        entry.key === waitKey ? null : entry.kind === 'comment' ? (
          entry.onAsk ? null : (
            <MobileBotItemCommentCard
              key={entry.key}
              item={item}
              entry={answered ? { ...entry, waiting: false } : entry}
              attachments={attachments}
              ref={(node) => {
                if (node) {
                  cards.current.set(entry.key, node)
                } else {
                  cards.current.delete(entry.key)
                }
              }}
              onShowQuestion={showQuestion(entry.replyTo?.eventId)}
              onShowLive={
                entry.ended === 'replaced' && liveAsk !== entry.key
                  ? showQuestion(liveAsk ?? undefined)
                  : null
              }
              itemScope={itemScope}
              quickReplies={quickReplies}
              repliesDisabled={repliesDisabled}
              {...(flash?.id === entry.key
                ? { flash: { at: flash.at, still, end: endFlash } }
                : {})}
            />
          )
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
            <Text style={styles.meta} accessibilityLabel={time.full(entry.at)}>
              {time.label(entry.at)}
            </Text>
          </View>
        )
      )}
      {item.status === 'waiting' && item.wait ? (
        <MobileBotItemWaitCard text={item.wait.text} at={item.wait.at} />
      ) : null}
      {pending.shown.map(({ event, failed, mayHaveArrived }) =>
        // Answers posted as one comment show on their lines already.
        !failed && event.data.text === quickReplies.sent?.text ? null : (
          <MobileBotItemCommentCard
            key={event.id}
            item={item}
            entry={{ event, waiting: false }}
            attachments={attachments}
            failed={
              failed
                ? {
                    retry: mayHaveArrived ? null : () => pending.retry(event.id),
                    discard: () => pending.discard(event.id)
                  }
                : undefined
            }
          />
        )
      )}
      {entries.some((entry) => entry.kind === 'comment') || pending.shown.length > 0 ? null : (
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
  meta: { fontSize: typography.metaSize, color: colors.textMuted, fontVariant: ['tabular-nums'] }
}))
