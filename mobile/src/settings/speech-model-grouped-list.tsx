import { Fragment } from 'react'
import { Pressable, Text, View } from 'react-native'
import { KeyRound } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { SpeechProviderLogo } from '../components/SpeechProviderLogo'
import { voiceSettingsStyles } from './voice-settings-styles'
import { voiceCabinetHitSlop, voiceCabinetStyles as styles } from './voice-cabinet-styles'
import { SpeechModelRow, type SpeechModelBusyAction } from './speech-model-row'
import {
  isCloudSpeechProvider,
  isLocalSpeechProvider,
  speechProviderKind,
  speechProviderLabel,
  speechProviderStatusText
} from '../dictation/speech-provider-presentation'
import type {
  MobileSpeechProvider,
  MobileSpeechProviderModel,
  MobileSpeechProvidersState
} from '../dictation/speech-provider-reply-schema'

export type SpeechModelBusy = { modelId: string; type: SpeechModelBusyAction }

export type SpeechModelGroupedListProps = {
  state: MobileSpeechProvidersState
  busy: SpeechModelBusy | null
  onSelect: (model: MobileSpeechProviderModel) => void
  onDownload: (model: MobileSpeechProviderModel) => void
  onOpenProvider: (provider: MobileSpeechProvider) => void
}

/** Every model the desktop can run, grouped by provider; unusable ones stay visible with the step that unlocks them. */
export function SpeechModelGroupedList({
  state,
  busy,
  onSelect,
  onDownload,
  onOpenProvider
}: SpeechModelGroupedListProps) {
  return state.providers
    .filter((provider) => provider.models.length > 0)
    .map((provider) => {
      const local = isLocalSpeechProvider(provider)
      return (
        <Fragment key={provider.id}>
          <View style={styles.drawerGroupHeader}>
            <SpeechProviderLogo providerId={provider.id} size={20} />
            <Text style={styles.drawerGroupTitle} numberOfLines={1}>
              {speechProviderLabel(provider).toUpperCase()}
            </Text>
            {isCloudSpeechProvider(provider) && !provider.keyConfigured ? (
              <Pressable
                style={({ pressed }) => [styles.groupKeyButton, pressed && styles.actionPressed]}
                hitSlop={voiceCabinetHitSlop.groupKeyButton}
                disabled={busy !== null}
                onPress={() => onOpenProvider(provider)}
                accessibilityRole="button"
                accessibilityLabel={'Add ' + speechProviderLabel(provider) + ' API key'}
                testID={`speech-provider-add-key-${provider.id}`}
              >
                <KeyRound size={12} color={colors.textSecondary} strokeWidth={2.2} />
                <Text style={styles.groupKeyButtonText}>Add key</Text>
              </Pressable>
            ) : (
              <Text style={styles.drawerGroupStatus} numberOfLines={1}>
                {speechProviderStatusText(provider)}
              </Text>
            )}
          </View>
          <View style={voiceSettingsStyles.section}>
            {provider.models.map((model, index) => (
              <Fragment key={model.id}>
                {index > 0 ? <View style={voiceSettingsStyles.separator} /> : null}
                <SpeechModelRow
                  model={model}
                  local={local}
                  selected={model.id === state.selectedModelId}
                  busy={busy?.modelId === model.id ? busy.type : null}
                  locked={busy !== null}
                  readOnly={speechProviderKind(provider) === 'unknown'}
                  variant="picker"
                  onSelect={() => onSelect(model)}
                  onDownload={() => onDownload(model)}
                />
              </Fragment>
            ))}
          </View>
        </Fragment>
      )
    })
}
