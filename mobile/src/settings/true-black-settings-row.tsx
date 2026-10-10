import { useState } from 'react'
import { StyleSheet, Switch, Text, View } from 'react-native'
import { colors, isTrueBlackActive, spacing, typography } from '../theme/mobile-theme'
import { readTrueBlackPreference, saveTrueBlackPreference } from '../theme/true-black-preference'

const styles = StyleSheet.create({
  panel: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    overflow: 'hidden',
    marginTop: spacing.md
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  rowText: {
    flex: 1
  },
  rowLabel: {
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary
  },
  rowSubtitle: {
    fontSize: typography.metaSize,
    color: colors.textSecondary
  },
  restartHint: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    paddingHorizontal: spacing.md + 2,
    paddingBottom: spacing.sm
  }
})

export function TrueBlackSettingsRow() {
  const [enabled, setEnabled] = useState(() => readTrueBlackPreference())

  // Palette is fixed at module load, so a changed choice applies only after a restart.
  const needsRestart = enabled !== isTrueBlackActive

  return (
    <View style={styles.panel}>
      <View style={styles.row}>
        <View style={styles.rowText}>
          <Text style={styles.rowLabel}>True black</Text>
          <Text style={styles.rowSubtitle}>Pure black backgrounds for OLED screens.</Text>
        </View>
        <Switch
          value={enabled}
          accessibilityLabel="True black"
          onValueChange={(value) => {
            setEnabled(value)
            saveTrueBlackPreference(value)
          }}
          trackColor={{ false: colors.bgRaised, true: colors.textSecondary }}
          thumbColor={colors.textPrimary}
        />
      </View>
      {needsRestart && <Text style={styles.restartHint}>Restart Orca to apply.</Text>}
    </View>
  )
}
