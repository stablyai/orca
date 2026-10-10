import { Pressable, Text, View } from 'react-native'
import { ChevronRight, Cloud, Languages, Mic } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { SpeechProviderLogo } from '../components/SpeechProviderLogo'
import { voiceSettingsStyles as base } from './voice-settings-styles'
import { voiceCabinetStyles as styles } from './voice-cabinet-styles'
import { SpeechModelLivePill } from './speech-model-row'
import { SpeechProviderRow } from './speech-provider-row'
import {
  findSelectedSpeechModel,
  isCloudSpeechProvider,
  isLocalSpeechProvider,
  speechModelLabel,
  speechProviderLabel,
  transcriptionLanguageSummary
} from '../dictation/speech-provider-presentation'
import type {
  MobileSpeechProvider,
  MobileSpeechProvidersState
} from '../dictation/speech-provider-reply-schema'

type Props = {
  state: MobileSpeechProvidersState
  onOpenModelPicker: () => void
  onOpenLanguagePicker: () => void
  onOpenProvider: (provider: MobileSpeechProvider) => void
  onOpenCloudProviders: () => void
}

function cloudProvidersSummary(total: number, connected: number): string {
  if (connected === 0) {
    return `${total} available · none connected`
  }
  return `${connected} connected of ${total}`
}

export function VoiceCabinetSections({
  state,
  onOpenModelPicker,
  onOpenLanguagePicker,
  onOpenProvider,
  onOpenCloudProviders
}: Props) {
  const selected = findSelectedSpeechModel(state)
  const local = state.providers.find(isLocalSpeechProvider) ?? null
  const cloud = state.providers.filter((provider) => !isLocalSpeechProvider(provider))
  const connectedCount = cloud.filter(
    (provider) => isCloudSpeechProvider(provider) && provider.keyConfigured === true
  ).length
  return (
    <>
      <Text style={[base.groupHeading, base.inputGroupGap]}>MODEL</Text>
      <View style={[base.section, base.sectionTopGap]}>
        <Pressable
          style={({ pressed }) => [base.row, pressed && base.rowPressed]}
          testID="voice-model-picker"
          accessibilityRole="button"
          accessibilityLabel="Speech model"
          onPress={onOpenModelPicker}
        >
          {selected ? (
            <SpeechProviderLogo providerId={selected.provider.id} />
          ) : (
            <View style={styles.iconTile}>
              <Mic size={17} color={colors.textPrimary} strokeWidth={1.9} />
            </View>
          )}
          <View style={base.rowContent}>
            <View style={styles.rowTitleLine}>
              <Text style={[base.rowLabel, styles.rowLabelShrink]} numberOfLines={1}>
                {selected ? speechModelLabel(selected.model) : 'Choose a speech model'}
              </Text>
              {selected?.model.realtime ? <SpeechModelLivePill /> : null}
            </View>
            <Text style={base.rowSublabel} numberOfLines={1}>
              {selected
                ? `${speechProviderLabel(selected.provider)}${
                    selected.model.status === 'ready' ? '' : ' · not ready'
                  }`
                : 'On-device or cloud'}
            </Text>
          </View>
          <ChevronRight size={18} color={colors.textMuted} />
        </Pressable>
        <View style={base.separator} />
        <Pressable
          style={({ pressed }) => [base.row, pressed && base.rowPressed]}
          testID="voice-language-picker"
          accessibilityRole="button"
          accessibilityLabel="Language"
          onPress={onOpenLanguagePicker}
        >
          <View style={styles.iconTile}>
            <Languages size={17} color={colors.textPrimary} strokeWidth={1.9} />
          </View>
          <View style={base.rowContent}>
            <Text style={base.rowLabel}>Language</Text>
            <Text style={base.rowSublabel} numberOfLines={1}>
              {transcriptionLanguageSummary(state)}
            </Text>
          </View>
          <ChevronRight size={18} color={colors.textMuted} />
        </Pressable>
      </View>

      <Text style={[base.groupHeading, base.inputGroupGap]}>PROVIDERS</Text>
      <View style={[base.section, base.sectionTopGap]}>
        {local ? (
          <>
            <SpeechProviderRow
              provider={local}
              inUse={selected?.provider.id === local.id}
              onPress={() => onOpenProvider(local)}
            />
            <View style={base.separator} />
          </>
        ) : null}
        <Pressable
          style={({ pressed }) => [base.row, pressed && base.rowPressed]}
          testID="voice-cloud-providers"
          accessibilityRole="button"
          accessibilityLabel="Cloud providers"
          onPress={onOpenCloudProviders}
        >
          <View style={styles.iconTile}>
            <Cloud size={17} color={colors.textPrimary} strokeWidth={1.9} />
          </View>
          <View style={base.rowContent}>
            <Text style={base.rowLabel}>Cloud providers</Text>
            <View style={styles.statusLine}>
              {connectedCount > 0 ? <View style={styles.statusDot} /> : null}
              <Text
                style={connectedCount > 0 ? styles.statusText : styles.statusTextMuted}
                numberOfLines={1}
              >
                {cloudProvidersSummary(cloud.length, connectedCount)}
              </Text>
            </View>
          </View>
          {selected && !isLocalSpeechProvider(selected.provider) ? (
            <Text style={styles.inUseText}>In use</Text>
          ) : null}
          <ChevronRight size={18} color={colors.textMuted} />
        </Pressable>
      </View>
    </>
  )
}
