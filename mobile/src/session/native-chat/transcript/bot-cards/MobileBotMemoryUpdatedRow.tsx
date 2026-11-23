import { Pressable, Text, View } from 'react-native'
import { ChevronDown, ChevronRight } from '../../../../components/icons/app-icons'
import {
  BOT_MEMORY_UPDATED_COPY as COPY,
  botMemoryUpdatedRows,
  botMemoryUpdatedSummary,
  type BotMemoryUpdatedNote,
  type BotMemoryUpdatedRow
} from '../../../../../../src/shared/bots/bot-memory-updated-note'
import type { Translate } from '../../../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { colors, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { scaledType } from '../messages/mobile-native-chat-message-styles'
import { useMobileNativeChatDisclosure } from '../viewport/mobile-native-chat-disclosure-store'
import { useBotPanelOpener } from '../../../../bots/bot-item-open'

function changeLabel(change: BotMemoryUpdatedRow['change'], t: Translate): string {
  switch (change) {
    case 'added':
      return t('chat.botCards.memory.added', COPY.added)
    case 'removed':
      return t('chat.botCards.memory.removed', COPY.removed)
    case 'noteChanged':
      return t('chat.botCards.memory.noteChanged', COPY.noteChanged)
  }
}

/** A quiet line that folds open to the bot's memory changes, and Open memory, as the desktop's. */
export function MobileBotMemoryUpdatedRow({
  note,
  cardId,
  fontScale
}: {
  note: BotMemoryUpdatedNote
  /** The transcript row carrying it, so its fold outlives the row. */
  cardId: string
  fontScale: number
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [open, setOpen] = useMobileNativeChatDisclosure(`bot-memory:${cardId}`, false)
  const panel = useBotPanelOpener(note.botId)
  const Chevron = open ? ChevronDown : ChevronRight
  const meta = scaledType(typography.metaSize, fontScale)
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        hitSlop={8}
        style={styles.line}
      >
        <Text style={[styles.summary, scaledType(typography.bodySize, fontScale)]}>
          {botMemoryUpdatedSummary(note)}
        </Text>
        <Chevron size={14} color={colors.textMuted} />
      </Pressable>
      {open ? (
        <View style={styles.changes}>
          {botMemoryUpdatedRows(note).map((row) => (
            <Text
              key={`${row.change}:${row.key}`}
              style={[styles.value, scaledType(typography.bodySize, fontScale)]}
            >
              <Text style={[styles.label, meta]}>{`${changeLabel(row.change, t)}  `}</Text>
              <Text
                style={[
                  row.change === 'removed' && styles.removed,
                  row.change === 'noteChanged' && styles.mono
                ]}
              >
                {row.text}
              </Text>
            </Text>
          ))}
          {note.otherChanges > 0 ? (
            <Text style={[styles.value, scaledType(typography.bodySize, fontScale)]}>
              {t('chat.botCards.memory.indexChanged', COPY.indexChanged)}
            </Text>
          ) : null}
          {panel ? (
            <Pressable
              accessibilityRole="link"
              onPress={() => panel.open({ settings: 'memory' })}
              hitSlop={8}
              style={styles.openMemory}
            >
              <Text style={[styles.openMemoryText, meta]}>
                {t('chat.botCards.memory.openMemory', COPY.openMemory)}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  line: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, alignSelf: 'flex-start' },
  summary: { color: colors.textMuted, flexShrink: 1 },
  changes: {
    marginTop: spacing.xs,
    paddingLeft: spacing.md,
    borderLeftWidth: 2,
    borderLeftColor: colors.borderSubtle,
    gap: spacing.xs
  },
  value: { color: colors.textPrimary },
  label: { color: colors.textMuted },
  removed: { textDecorationLine: 'line-through' },
  mono: { fontFamily: typography.monoFamily, fontSize: typography.metaSize },
  openMemory: { alignSelf: 'flex-start' },
  openMemoryText: { color: colors.textMuted, textDecorationLine: 'underline' }
}))
