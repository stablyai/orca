import { Pressable, Text, View } from 'react-native'
import { ChevronRight } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { SpeechProviderLogo } from '../components/SpeechProviderLogo'
import { voiceSettingsStyles as base } from './voice-settings-styles'
import { voiceCabinetStyles as styles } from './voice-cabinet-styles'
import {
  isCloudSpeechProvider,
  speechProviderLabel,
  speechProviderStatusText
} from '../dictation/speech-provider-presentation'
import type { MobileSpeechProvider } from '../dictation/speech-provider-reply-schema'

export function SpeechProviderRow({
  provider,
  inUse,
  onPress
}: {
  provider: MobileSpeechProvider
  inUse: boolean
  onPress: () => void
}) {
  const connected = isCloudSpeechProvider(provider) && provider.keyConfigured === true
  return (
    <Pressable
      style={({ pressed }) => [base.row, pressed && base.rowPressed]}
      testID={`voice-provider-${provider.id}`}
      accessibilityRole="button"
      accessibilityLabel={speechProviderLabel(provider)}
      onPress={onPress}
    >
      <SpeechProviderLogo providerId={provider.id} />
      <View style={base.rowContent}>
        <Text style={base.rowLabel} numberOfLines={1}>
          {speechProviderLabel(provider)}
        </Text>
        <View style={styles.statusLine}>
          {connected ? <View style={styles.statusDot} /> : null}
          <Text style={connected ? styles.statusText : styles.statusTextMuted} numberOfLines={1}>
            {speechProviderStatusText(provider)}
          </Text>
        </View>
      </View>
      {inUse ? <Text style={styles.inUseText}>In use</Text> : null}
      <ChevronRight size={18} color={colors.textMuted} />
    </Pressable>
  )
}
