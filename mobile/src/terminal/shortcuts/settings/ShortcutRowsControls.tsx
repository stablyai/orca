import { Pressable, Text, View } from 'react-native'
import { Minus, Plus } from 'lucide-react-native'
import { ListRow } from '../../../components/list/ListGroup'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { colors } from '../../../theme/mobile-theme'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import type { TerminalAccessoryKey } from '../../key-input/terminal-accessory-keys'
import {
  MAX_TERMINAL_ACCESSORY_ROWS,
  MIN_TERMINAL_ACCESSORY_ROWS,
  ROW_DIVIDER_ID_PREFIX,
  getTerminalAccessoryBuiltInRows,
  type TerminalAccessoryLayout
} from '../../key-input/terminal-accessory-layout'
import { styles } from './terminal-shortcut-settings-styles'

export type ShortcutBarItem =
  | { kind: 'key'; id: string; shortcutKey: TerminalAccessoryKey }
  | { kind: 'divider'; id: string; rowNumber: number }

/** Builds interleaved built-in keys and non-draggable row dividers for DragReorderList. */
export function buildShortcutReorderItems(
  layout: TerminalAccessoryLayout,
  allKeys: readonly TerminalAccessoryKey[]
): { rowCount: number; items: ShortcutBarItem[] } {
  const byId = new Map(allKeys.map((key) => [key.id, key]))
  const rowIds = getTerminalAccessoryBuiltInRows(layout)
  const items: ShortcutBarItem[] = []
  for (let rowIndex = 0; rowIndex < rowIds.length; rowIndex++) {
    if (rowIndex > 0) {
      items.push({
        kind: 'divider',
        id: `${ROW_DIVIDER_ID_PREFIX}${rowIndex + 1}`,
        rowNumber: rowIndex + 1
      })
    }
    for (const id of rowIds[rowIndex]!) {
      const shortcutKey = byId.get(id)
      if (shortcutKey) {
        items.push({ kind: 'key', id, shortcutKey })
      }
    }
  }
  return { rowCount: rowIds.length, items }
}

/** Static header marking the first shortcut row above the reorderable list when >1 row is active. */
export function ShortcutRowHeader({ label }: { label: string }): React.JSX.Element {
  useMobileColorScheme()
  return (
    <View style={styles.rowHeader}>
      <Text style={styles.rowHeaderText}>{label}</Text>
    </View>
  )
}

/** Non-draggable row divider rendered inside DragReorderList to separate shortcut rows 2–4. */
export function ShortcutRowDivider({ label }: { label: string }): React.JSX.Element {
  useMobileColorScheme()
  return (
    <View style={styles.rowDividerContent}>
      <Text style={styles.rowHeaderText}>{label}</Text>
    </View>
  )
}

/** Stepper row in Terminal Shortcut Settings for selecting 1–4 stacked key bar rows. */
export function ShortcutRowsSettingRow({
  rowCount,
  onChangeRowCount
}: {
  rowCount: number
  onChangeRowCount: (nextCount: number) => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const canDecrease = rowCount > MIN_TERMINAL_ACCESSORY_ROWS
  const canIncrease = rowCount < MAX_TERMINAL_ACCESSORY_ROWS

  return (
    <ListRow
      title={t('components.terminalShortcutSettings.shortcutRows', 'Shortcut Rows')}
      subtitle={t(
        'components.terminalShortcutSettings.shortcutRowsDescription',
        'Stack built-in keys across 1 to 4 rows on the terminal bar'
      )}
      accessory={
        <View style={styles.stepper}>
          <Pressable
            style={({ pressed }) => [
              styles.stepperButton,
              pressed && canDecrease && styles.stepperButtonPressed,
              !canDecrease && styles.stepperButtonDisabled
            ]}
            disabled={!canDecrease}
            onPress={() => onChangeRowCount(rowCount - 1)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t(
              'components.terminalShortcutSettings.decreaseRows',
              'Decrease shortcut rows'
            )}
          >
            <Minus
              size={15}
              color={canDecrease ? colors.textPrimary : colors.textMuted}
              strokeWidth={2.2}
            />
          </Pressable>
          <Text style={styles.stepperValue}>{rowCount}</Text>
          <Pressable
            style={({ pressed }) => [
              styles.stepperButton,
              pressed && canIncrease && styles.stepperButtonPressed,
              !canIncrease && styles.stepperButtonDisabled
            ]}
            disabled={!canIncrease}
            onPress={() => onChangeRowCount(rowCount + 1)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t(
              'components.terminalShortcutSettings.increaseRows',
              'Increase shortcut rows'
            )}
          >
            <Plus
              size={15}
              color={canIncrease ? colors.textPrimary : colors.textMuted}
              strokeWidth={2.2}
            />
          </Pressable>
        </View>
      }
    />
  )
}
