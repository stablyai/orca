import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { FileText, Package, Terminal } from 'lucide-react-native'
import type { NativeChatPickerItem } from '../../../../../src/shared/native-chat/input/native-chat-picker-items'
import { colors, spacing, typography } from '../../../theme/mobile-theme'

export type ComposerMenuRow = NativeChatPickerItem | { kind: 'file'; id: string; path: string }

export function composerMenuInsertText(row: ComposerMenuRow): string {
  return row.kind === 'file' ? `@${row.path}` : row.token
}

const HEADINGS = { command: 'Commands', skill: 'Skills', file: 'Files' } as const

export function MobileNativeChatComposerMenu({
  rows,
  onPick
}: {
  rows: readonly ComposerMenuRow[]
  onPick: (row: ComposerMenuRow) => void
}): React.JSX.Element {
  return (
    <View style={styles.card}>
      <ScrollView keyboardShouldPersistTaps="always" style={styles.scroll}>
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
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={() => onPick(row)}
    >
      <Icon size={16} color={colors.textSecondary} strokeWidth={2} style={styles.icon} />
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
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.composerBorder,
    backgroundColor: colors.bgPanel,
    overflow: 'hidden'
  },
  scroll: {
    maxHeight: 300
  },
  heading: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs
  },
  row: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    minHeight: 44
  },
  rowPressed: {
    backgroundColor: colors.bgRaised
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
    fontSize: 13.5
  },
  hint: {
    flexShrink: 1,
    color: colors.textMuted,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize
  },
  description: {
    color: colors.textMuted,
    fontSize: 12.5,
    lineHeight: 17
  }
})
