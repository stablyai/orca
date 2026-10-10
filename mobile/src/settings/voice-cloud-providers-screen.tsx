import { Fragment } from 'react'
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChevronLeft } from 'lucide-react-native'
import { colors, spacing } from '../theme/mobile-theme'
import { voiceSettingsStyles as base } from './voice-settings-styles'
import { voiceCabinetStyles as cabinet } from './voice-cabinet-styles'
import type { VoiceSettingsOperations } from './voice-settings-operations'
import { VOICE_HOST_UNPAIRED_MESSAGE } from './voice-settings-host-selection'
import { useVoiceProviderController } from './use-voice-provider-controller'
import { SpeechProviderRow } from './speech-provider-row'
import { VoiceErrorList } from './voice-error-list'
import {
  findSelectedSpeechModel,
  isLocalSpeechProvider
} from '../dictation/speech-provider-presentation'

type Props = {
  operations: VoiceSettingsOperations | null
  focused: boolean
  /** The session's desktop was unpaired; show that instead of another desktop's providers. */
  unpaired?: boolean
  onBack: () => void
  onOpenProvider: (providerId: string) => void
}

/** Every cloud speech provider with its key status; one row per provider, one key each. */
export default function VoiceCloudProvidersScreen({
  operations,
  focused,
  unpaired = false,
  onBack,
  onOpenProvider
}: Props) {
  const insets = useSafeAreaInsets()
  const { state, loading, error, errors } = useVoiceProviderController(operations, focused)
  const cloud = state?.providers.filter((provider) => !isLocalSpeechProvider(provider)) ?? []
  const selected = state ? findSelectedSpeechModel(state) : null

  return (
    <View style={[base.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={base.topRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={base.backButton}
          onPress={onBack}
        >
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={base.heading}>Cloud providers</Text>
      </View>

      {unpaired || (!state && !operations && focused) ? (
        <View style={[base.section, base.sectionTopGap]}>
          <Text style={base.emptyText}>
            {unpaired
              ? VOICE_HOST_UNPAIRED_MESSAGE
              : 'Connect to a desktop to manage speech providers.'}
          </Text>
        </View>
      ) : !state && (loading || !operations || !error) ? (
        <View style={base.loading}>
          <ActivityIndicator color={colors.textSecondary} />
        </View>
      ) : !state ? (
        <View style={[base.section, base.sectionTopGap]}>
          <Text style={base.errorText}>{error}</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={base.scrollContent} showsVerticalScrollIndicator={false}>
          <Text style={base.groupHeading}>PROVIDERS</Text>
          <View style={[base.section, base.sectionTopGap]}>
            {cloud.map((provider, index) => (
              <Fragment key={provider.id}>
                {index > 0 ? <View style={base.separator} /> : null}
                <SpeechProviderRow
                  provider={provider}
                  inUse={selected?.provider.id === provider.id}
                  onPress={() => onOpenProvider(provider.id)}
                />
              </Fragment>
            ))}
          </View>
          <Text style={cabinet.footnote}>
            One API key per provider unlocks all of its models. Keys are encrypted on your desktop
            and never sent back to this phone; speech goes from your desktop straight to the
            provider you pick.
          </Text>
          <VoiceErrorList messages={errors} />
        </ScrollView>
      )}
    </View>
  )
}
