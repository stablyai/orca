// Memory › History: every change to MEMORY.md by day, newest first; open one to see its lines and Undo it.
import { useEffect, useState } from 'react'
import { Text, View } from 'react-native'
import {
  ChevronDown,
  ChevronUp,
  Minus,
  Pencil,
  Plus,
  RotateCcw,
  Sparkles,
  type LucideIcon
} from 'lucide-react-native'
import type { BotMemoryHistoryView } from '../../../../src/shared/bots/bot-memory-history'
import {
  botMemoryHistoryAuthor,
  botMemoryHistoryKind,
  botMemoryHistoryLine,
  botMemoryHistorySummary,
  type BotMemoryHistoryKind
} from '../../../../src/shared/bots/bot-memory-history-copy'
import {
  LIST_LEADING_INSET,
  LIST_ROW_PADDING,
  ListGroup,
  ListRow,
  SectionHeader
} from '../../components/list/ListGroup'
import { intlLocaleFor } from '../../i18n/ui-intl-locale'
import { useMobileTranslation, useMobileUiLocale } from '../../i18n/use-mobile-translation'
import { SettingsNote } from '../../settings/settings-screen-frame'
import { radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { MobileBotTextButton } from '../MobileBotTextButton'
import { botMemoryHistory, botMemoryUndo } from './bot-memory-operations'
import type { MemoryActions } from './MobileBotMemory'

const DAY_MS = 24 * 60 * 60 * 1000

const ICONS: Record<BotMemoryHistoryKind, LucideIcon> = {
  'tidy-up': Sparkles,
  undo: RotateCcw,
  edit: Pencil,
  forget: Minus,
  add: Plus
}

function dayLabel(
  t: ReturnType<typeof useMobileTranslation>,
  intlLocale: string,
  at: number,
  now: Date
): string {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (at >= today) {
    return t('settings.bots.memoryHistory.today', 'Today')
  }
  if (at >= today - DAY_MS) {
    return t('settings.bots.memoryHistory.yesterday', 'Yesterday')
  }
  return new Intl.DateTimeFormat(intlLocale, { month: 'short', day: 'numeric' }).format(at)
}

function HistoryRow(props: {
  row: BotMemoryHistoryView
  open: boolean
  disabled: boolean
  onToggle: () => void
  onUndo: () => void
}) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const intlLocale = intlLocaleFor(useMobileUiLocale())
  const { row } = props
  const Icon = ICONS[botMemoryHistoryKind(row)]
  const time = new Intl.DateTimeFormat(intlLocale, {
    hour: 'numeric',
    minute: '2-digit'
  }).format(row.at)
  const Chevron = props.open ? ChevronUp : ChevronDown
  // The desktop's tidy-up line explains Undo; on a phone row the name is enough.
  const author =
    row.by.kind === 'tidy-up' && row.undoable
      ? t('bots.memoryHistory.tidyUp', 'Tidy-up')
      : botMemoryHistoryAuthor(t, row)
  return (
    <View>
      <ListRow
        leading={
          <View style={styles.mark}>
            <Icon size={13} color={colors.textSecondary} strokeWidth={2.4} />
          </View>
        }
        title={botMemoryHistorySummary(t, row)}
        wrapTitle
        subtitle={`${author} · ${time}`}
        subtitleLines={2}
        accessory={<Chevron size={16} color={colors.textMuted} strokeWidth={2.2} />}
        onPress={props.onToggle}
      />
      {props.open ? (
        <View style={styles.opened}>
          <View style={styles.diff}>
            {row.change.removed.map((entry) => (
              <Text key={`-${entry.line}`} style={[styles.diffLine, styles.removed]}>
                {`− ${botMemoryHistoryLine(entry)}`}
              </Text>
            ))}
            {row.change.added.map((entry) => (
              <Text key={`+${entry.line}`} style={[styles.diffLine, styles.added]}>
                {`+ ${botMemoryHistoryLine(entry)}`}
              </Text>
            ))}
          </View>
          {row.undoable ? (
            <View style={styles.undo}>
              <MobileBotTextButton
                label={t('settings.bots.memoryHistory.undoAction', 'Undo')}
                accent
                disabled={props.disabled}
                onPress={props.onUndo}
              />
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

/** Reads the history again whenever `version` (MEMORY.md as last read) changes. */
export function MobileBotMemoryHistory(props: {
  client: RpcClient | null
  botId: string
  version: string
  disabled: boolean
  actions: MemoryActions
}) {
  const t = useMobileTranslation()
  const intlLocale = intlLocaleFor(useMobileUiLocale())
  const { client, botId, version } = props
  // Days are named as of the load.
  const [loaded, setLoaded] = useState<{ rows: BotMemoryHistoryView[]; now: Date } | null>(null)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => {
    if (!client) {
      return
    }
    let live = true
    botMemoryHistory
      .request(client, { botId })
      .then((reply) => botMemoryHistory.interpret(reply).rows)
      .then(
        (rows) => {
          if (live) {
            setLoaded({ rows, now: new Date() })
            setFailed(false)
          }
        },
        () => live && setFailed(true)
      )
    return () => {
      live = false
    }
  }, [client, botId, version])

  const undo = (id: string) =>
    props.actions.run(async (rpc) => {
      const reply = botMemoryUndo.interpret(
        await botMemoryUndo.request(rpc, { botId, id }, { failWhenDisconnected: true })
      )
      if (!reply.undone) {
        props.actions.showToast(
          t(
            'settings.bots.memoryHistory.nothingToUndo',
            'Nothing left to undo: those lines changed since.'
          )
        )
      }
    })

  if (loaded === null) {
    return failed ? (
      <SettingsNote>{t('bots.errors.generic', 'Something went wrong. Try again.')}</SettingsNote>
    ) : null
  }
  if (loaded.rows.length === 0) {
    return <SettingsNote>{t('settings.bots.memoryHistory.empty', 'No changes yet.')}</SettingsNote>
  }
  const groups: { day: string; rows: BotMemoryHistoryView[] }[] = []
  for (const row of loaded.rows) {
    const day = dayLabel(t, intlLocale, row.at, loaded.now)
    const last = groups.at(-1)
    if (last && last.day === day) {
      last.rows.push(row)
    } else {
      groups.push({ day, rows: [row] })
    }
  }
  return (
    <>
      {groups.map((group) => (
        <View key={group.day}>
          <SectionHeader title={group.day} />
          <ListGroup separatorInset={LIST_LEADING_INSET}>
            {group.rows.map((row) => (
              <HistoryRow
                key={row.id}
                row={row}
                open={open === row.id}
                disabled={props.disabled}
                onToggle={() => setOpen(open === row.id ? null : row.id)}
                onUndo={() => undo(row.id)}
              />
            ))}
          </ListGroup>
        </View>
      ))}
    </>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  mark: {
    width: 20,
    height: 20,
    borderRadius: radii.pill,
    backgroundColor: colors.translucentFill,
    alignItems: 'center',
    justifyContent: 'center'
  },
  opened: {
    paddingLeft: LIST_LEADING_INSET,
    paddingRight: LIST_ROW_PADDING,
    paddingBottom: spacing.md,
    gap: spacing.sm
  },
  diff: { borderRadius: radii.mark, overflow: 'hidden' },
  diffLine: {
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    lineHeight: 18,
    color: colors.textPrimary,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xxs
  },
  removed: { backgroundColor: colors.diffDeletedBg },
  added: { backgroundColor: colors.diffAddedBg },
  // The text button's own inset, so Undo lines up with the lines above it.
  undo: { flexDirection: 'row', marginLeft: -spacing.xs }
}))
