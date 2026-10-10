import { Pressable, Switch, Text, View } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { voiceSettingsStyles as styles } from './voice-settings-styles'
import type { VoiceSettingsOperations } from './voice-settings-operations'

const DICTATION_MODES = [
  { value: 'toggle', label: 'Toggle' },
  { value: 'hold', label: 'Hold' }
] as const

type Props = {
  enabled: boolean
  dictationMode: string | undefined
  onConfigure: (params: Parameters<VoiceSettingsOperations['configure']>[0]) => void
}

export function VoiceDictationSection({ enabled, dictationMode, onConfigure }: Props) {
  return (
    <>
      <Text style={styles.groupHeading}>DICTATION</Text>
      <View style={[styles.section, styles.sectionTopGap]}>
        <View style={styles.row}>
          <View style={styles.rowContent}>
            <Text style={styles.rowLabel}>Enable Voice Dictation</Text>
            <Text style={styles.rowSublabel}>
              Dictate text into any focused pane on your desktop.
            </Text>
          </View>
          <Switch
            testID="voice-enabled"
            accessibilityLabel="Enable Voice Dictation"
            value={enabled}
            onValueChange={(next) => onConfigure({ enabled: next })}
            trackColor={{ false: colors.bgRaised, true: colors.textSecondary }}
            thumbColor={colors.textPrimary}
          />
        </View>

        <View style={styles.separator} />

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
            {DICTATION_MODES.map((mode) => {
              const active = dictationMode === mode.value
              return (
                <Pressable
                  key={mode.value}
                  accessibilityRole="radio"
                  aria-checked={active}
                  testID={`voice-mode-${mode.value}`}
                  onPress={() => onConfigure({ dictationMode: mode.value })}
                  style={[styles.segment, active && styles.segmentActive]}
                >
                  <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                    {mode.label}
                  </Text>
                </Pressable>
              )
            })}
          </View>
        </View>
      </View>
    </>
  )
}
