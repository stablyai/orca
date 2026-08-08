import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { DictationCorrectionMode, DictationMode } from '../../../src/shared/speech-types'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

const DICTATION_MODES = [
  { value: 'toggle', label: 'Toggle' },
  { value: 'hold', label: 'Hold' }
] as const

const CORRECTION_MODES = [
  { value: 'off', label: 'Off' },
  { value: 'preview', label: 'Preview' },
  { value: 'auto', label: 'Auto' }
] as const

type VoiceDictationPreferencesProps = {
  enabled: boolean
  dictationMode: DictationMode
  correctionMode: DictationCorrectionMode
  onSelectDictationMode: (mode: DictationMode) => void
  onSelectCorrectionMode: (mode: DictationCorrectionMode) => void
}

export function VoiceDictationPreferences({
  enabled,
  dictationMode,
  correctionMode,
  onSelectDictationMode,
  onSelectCorrectionMode
}: VoiceDictationPreferencesProps): React.JSX.Element {
  return (
    <>
      <View
        style={[styles.row, !enabled && styles.disabled]}
        pointerEvents={enabled ? 'auto' : 'none'}
      >
        <View style={styles.rowContent}>
          <Text style={styles.rowLabel}>Dictation Mode</Text>
          <Text style={styles.rowSublabel}>
            Toggle: press once to start, again to stop. Hold: dictate while held.
          </Text>
        </View>
        <View style={styles.segmented}>
          {DICTATION_MODES.map((mode) => (
            <Segment
              key={mode.value}
              active={dictationMode === mode.value}
              label={mode.label}
              onPress={() => onSelectDictationMode(mode.value)}
            />
          ))}
        </View>
      </View>

      <View style={styles.separator} />

      <View
        style={[styles.correctionRow, !enabled && styles.disabled]}
        pointerEvents={enabled ? 'auto' : 'none'}
      >
        <View>
          <Text style={styles.rowLabel}>Transcript Correction</Text>
          <Text style={styles.rowSublabel}>
            Local punctuation, spacing, and vocabulary cleanup before insertion.
          </Text>
        </View>
        <View style={styles.segmented}>
          {CORRECTION_MODES.map((mode) => (
            <Segment
              key={mode.value}
              active={correctionMode === mode.value}
              label={mode.label}
              onPress={() => onSelectCorrectionMode(mode.value)}
              fill
            />
          ))}
        </View>
      </View>
    </>
  )
}

function Segment({
  active,
  label,
  onPress,
  fill = false
}: {
  active: boolean
  label: string
  onPress: () => void
  fill?: boolean
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.segment, fill && styles.segmentFill, active && styles.segmentActive]}
    >
      <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  correctionRow: {
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  rowContent: { flex: 1 },
  rowLabel: {
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary
  },
  rowSublabel: {
    fontSize: typography.bodySize - 2,
    color: colors.textSecondary,
    marginTop: 2
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  },
  segmented: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgBase,
    borderRadius: radii.button,
    padding: 2
  },
  segment: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radii.button - 1,
    alignItems: 'center'
  },
  segmentFill: { flex: 1 },
  segmentActive: { backgroundColor: colors.bgRaised },
  segmentText: { fontSize: typography.metaSize, color: colors.textSecondary, fontWeight: '600' },
  segmentTextActive: { color: colors.textPrimary },
  disabled: { opacity: 0.5 }
})
