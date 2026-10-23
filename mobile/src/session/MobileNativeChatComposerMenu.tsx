import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { FileText, Package, Terminal } from 'lucide-react-native'
import type { NativeChatPickerItem } from '../../../src/shared/native-chat-picker-items'
import { colors, MIN_TOUCH_TARGET, spacing, textStyles, typography } from '../theme/mobile-theme'
import { pressTransition } from '../components/ui/transition-styles'

/** One row of the composer menu: a `/` command or skill, or a worktree file for `@`. */
export type ComposerMenuRow = NativeChatPickerItem | { kind: 'file'; id: string; path: string }

/** The text a row puts in place of the typed trigger. */
export function composerMenuInsertText(row: ComposerMenuRow): string {
  return row.kind === 'file' ? `@${row.path}` : row.token
}

const HEADINGS = { command: 'Commands', skill: 'Skills', file: 'Files' } as const

/** What the menu says when it has no rows: `@` paths still loading, or none matching. */
export type ComposerMenuStatus = 'loading-files' | 'no-files'

/** The floating card above the composer, grouped and labelled as desktop's `/` menu is. */
export function MobileNativeChatComposerMenu({
  rows,
  status = null,
  onPick
}: {
  rows: readonly ComposerMenuRow[]
  status?: ComposerMenuStatus | null
  onPick: (row: ComposerMenuRow) => void
}): React.JSX.Element {
  return (
    <View style={styles.card}>
      <ScrollView keyboardShouldPersistTaps="always" style={styles.scroll}>
        {rows.length === 0 && status ? (
          <View style={styles.statusRow} accessibilityLiveRegion="polite">
            {status === 'loading-files' ? (
              <ActivityIndicator size="small" color={colors.textSecondary} />
            ) : null}
            <Text style={styles.statusText}>
              {status === 'loading-files' ? 'Searching files…' : 'No matching files.'}
            </Text>
          </View>
        ) : null}
        {rows.map((row, index) => (
          <View key={row.id}>
            {rows[index - 1]?.kind !== row.kind ? (
              <Text style={styles.heading}>{HEADINGS[row.kind]}</Text>
            ) : null}
            <MenuRow row={row} onPick={onPick} />
          </View>
        ))}
      </ScrollView>
    </View>
  )
}

function MenuRow({
  row,
  onPick
}: {
  row: ComposerMenuRow
  onPick: (row: ComposerMenuRow) => void
}): React.JSX.Element {
  const Icon = row.kind === 'skill' ? Package : row.kind === 'command' ? Terminal : FileText
  const description = row.kind === 'file' ? null : row.description
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        row.kind === 'skill' && row.location
          ? `${row.token}, ${row.location}`
          : composerMenuInsertText(row)
      }
      style={({ pressed }) => [
        styles.row,
        pressed && styles.rowPressed,
        pressed ? pressTransition.pressed : pressTransition.rest
      ]}
      onPress={() => onPick(row)}
    >
      <Icon size={17} color={colors.textSecondary} strokeWidth={2} style={styles.icon} />
      <View style={styles.body}>
        <View style={styles.nameLine}>
          <Text style={styles.name} numberOfLines={1}>
            {row.kind === 'file' ? row.path : row.token}
          </Text>
          {row.kind === 'command' && row.argumentHint ? (
            <Text style={styles.hint} numberOfLines={1}>
              {row.argumentHint}
            </Text>
          ) : null}
        </View>
        {description ? (
          <Text style={styles.description} numberOfLines={2}>
            {description}
          </Text>
        ) : null}
        {row.kind === 'skill' && row.location ? (
          <Text style={styles.description}>{row.location}</Text>
        ) : null}
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 10,
    marginBottom: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: colors.separator,
    backgroundColor: colors.bgPanel,
    overflow: 'hidden'
  },
  scroll: {
    maxHeight: 300
  },
  heading: {
    ...textStyles.footnote,
    fontWeight: '500',
    color: colors.textMuted,
    paddingHorizontal: spacing.lg + 4,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs
  },
  row: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.lg + 4,
    paddingVertical: 10,
    minHeight: MIN_TOUCH_TARGET + 4
  },
  rowPressed: {
    backgroundColor: colors.fill
  },
  icon: {
    marginTop: 2
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: 2
  },
  nameLine: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6
  },
  name: {
    flexShrink: 1,
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: 14,
    lineHeight: 20
  },
  hint: {
    flexShrink: 1,
    color: colors.textMuted,
    fontFamily: typography.monoFamily,
    fontSize: 13
  },
  description: {
    ...textStyles.footnote,
    color: colors.textMuted
  },
  statusRow: {
    minHeight: MIN_TOUCH_TARGET + 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg + 4
  },
  statusText: {
    ...textStyles.subhead,
    color: colors.textSecondary
  }
})
