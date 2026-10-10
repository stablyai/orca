import { Fragment } from 'react'
import { Pressable, Text, View } from 'react-native'
import { Check } from 'lucide-react-native'
import { BottomDrawer } from '../components/BottomDrawer'
import { colors } from '../theme/mobile-theme'
import { voiceSettingsStyles } from './voice-settings-styles'
import { voiceCabinetStyles as styles } from './voice-cabinet-styles'
import {
  AUTO_TRANSCRIPTION_LANGUAGE,
  SPEECH_TRANSCRIPTION_LANGUAGES
} from '../../../src/shared/speech-transcription-languages'
import {
  isLanguageSupported,
  type SpeechLanguageSupport
} from '../dictation/speech-provider-presentation'

type Props = {
  visible: boolean
  language: string | undefined
  /** What the selected model does with a hint; unsupported languages stay visible but locked. */
  support: SpeechLanguageSupport
  modelLabel: string | null
  onClose: () => void
  onSelect: (code: string) => void
}

function pickerSubtitle(support: SpeechLanguageSupport, modelLabel: string | null): string {
  if (modelLabel && support.kind === 'model-picks') {
    return `${modelLabel} detects the language itself, so only auto-detect applies.`
  }
  if (modelLabel && support.kind === 'hint' && support.codes !== null) {
    return `Greyed-out languages aren't supported by ${modelLabel}; it falls back to auto-detect.`
  }
  return 'A hint for cloud models. Auto-detect works for most speech.'
}

export function SpeechLanguagePickerDrawer({
  visible,
  language,
  support,
  modelLabel,
  onClose,
  onSelect
}: Props) {
  const current = language ?? AUTO_TRANSCRIPTION_LANGUAGE
  return (
    <BottomDrawer visible={visible} onClose={onClose}>
      <Text style={voiceSettingsStyles.drawerTitle}>Language</Text>
      <Text style={styles.drawerSubtitle}>{pickerSubtitle(support, modelLabel)}</Text>
      <View style={voiceSettingsStyles.section}>
        {SPEECH_TRANSCRIPTION_LANGUAGES.map((entry, index) => {
          const active = entry.code === current
          const supported = isLanguageSupported(support, entry.code)
          return (
            <Fragment key={entry.code}>
              {index > 0 ? <View style={voiceSettingsStyles.separator} /> : null}
              <Pressable
                style={({ pressed }) => [
                  styles.languageRow,
                  !supported && styles.modelRowDimmed,
                  pressed && voiceSettingsStyles.rowPressed
                ]}
                disabled={!supported}
                accessibilityRole="radio"
                aria-checked={active}
                aria-disabled={!supported}
                testID={`speech-language-${entry.code}`}
                onPress={() => onSelect(entry.code)}
              >
                <Text style={styles.languageLabel}>
                  {entry.label}
                  {supported ? '' : ' · not supported'}
                </Text>
                {entry.code === AUTO_TRANSCRIPTION_LANGUAGE ? null : (
                  <Text style={styles.languageCode}>{entry.code}</Text>
                )}
                {active ? (
                  <Check size={18} color={colors.statusGreen} strokeWidth={2.4} />
                ) : (
                  <View style={styles.checkPlaceholder} />
                )}
              </Pressable>
            </Fragment>
          )
        })}
      </View>
    </BottomDrawer>
  )
}
