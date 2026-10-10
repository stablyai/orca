import { Fragment } from 'react'
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChevronLeft } from 'lucide-react-native'
import { colors, spacing } from '../theme/mobile-theme'
import { ConfirmModal } from '../components/ConfirmModal'
import { SpeechProviderLogo } from '../components/SpeechProviderLogo'
import { voiceSettingsStyles as base } from './voice-settings-styles'
import { voiceCabinetStyles as cabinet } from './voice-cabinet-styles'
import { voiceProviderStyles as styles } from './voice-provider-styles'
import type { VoiceSettingsOperations } from './voice-settings-operations'
import { VOICE_HOST_UNPAIRED_MESSAGE } from './voice-settings-host-selection'
import { useVoiceProviderController } from './use-voice-provider-controller'
import { VoiceProviderKeySection } from './voice-provider-key-section'
import { SpeechProviderKeyDrawer } from './speech-provider-key-drawer'
import { SpeechModelRow } from './speech-model-row'
import { VoiceErrorList } from './voice-error-list'
import { speechProviderKind, speechProviderLabel } from '../dictation/speech-provider-presentation'

type Props = {
  operations: VoiceSettingsOperations | null
  focused: boolean
  /** The session's desktop was unpaired; show that instead of another desktop's providers. */
  unpaired?: boolean
  providerId: string
  onBack: () => void
}

export default function VoiceProviderScreen({
  operations,
  focused,
  unpaired = false,
  providerId,
  onBack
}: Props) {
  const insets = useSafeAreaInsets()
  const controller = useVoiceProviderController(operations, focused)
  const { state, loading, error, busyAction } = controller
  const provider = state?.providers.find((entry) => entry.id === providerId) ?? null
  const kind = provider ? speechProviderKind(provider) : 'unknown'
  const local = kind === 'local'
  // Why: key controls for a kind this build does not know could send its key to the wrong flow.
  const cloud = kind === 'cloud'
  const label = provider ? speechProviderLabel(provider) : 'Provider'

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
        <Text style={base.heading}>Voice</Text>
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
      ) : !provider ? (
        <View style={[base.section, base.sectionTopGap]}>
          <Text style={base.errorText}>
            {state ? 'This desktop does not offer that provider.' : error}
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={base.scrollContent} showsVerticalScrollIndicator={false}>
          <View style={styles.hero}>
            <SpeechProviderLogo providerId={provider.id} size={52} />
            <View style={styles.heroText}>
              <Text style={styles.heroTitle} numberOfLines={1}>
                {label}
              </Text>
              {provider.description ? (
                <Text style={styles.heroDescription}>{provider.description}</Text>
              ) : null}
            </View>
          </View>

          {cloud ? (
            <>
              <Text style={base.groupHeading}>API KEY</Text>
              <VoiceProviderKeySection
                provider={provider}
                keyAction={controller.keyAction}
                testResult={controller.testResult}
                onAddKey={controller.openKeyDrawer}
                onTest={() => void controller.testKey(provider.id)}
                onRemove={() => controller.setConfirmRemoveOpen(true)}
              />
            </>
          ) : null}

          <Text style={[base.groupHeading, cloud ? base.inputGroupGap : null]}>MODELS</Text>
          <View style={[base.section, base.sectionTopGap]}>
            {provider.models.map((model, index) => (
              <Fragment key={model.id}>
                {index > 0 ? <View style={base.separator} /> : null}
                <SpeechModelRow
                  model={model}
                  local={local}
                  selected={model.id === state?.selectedModelId}
                  busy={busyAction?.modelId === model.id ? busyAction.type : null}
                  locked={busyAction !== null}
                  readOnly={kind === 'unknown'}
                  variant="manage"
                  onSelect={() => void controller.selectModel(model.id)}
                  onDownload={() => void controller.downloadModel(model.id)}
                  onDelete={() => void controller.deleteModel(model.id)}
                />
              </Fragment>
            ))}
          </View>
          <Text style={cabinet.footnote}>
            {local
              ? 'On-device models run on your desktop. Audio never leaves it.'
              : !cloud
                ? `Update Orca on this phone to manage ${label} here, or set it up on your desktop.`
                : provider.keyConfigured
                  ? `Your desktop sends audio to ${label} only while you dictate with one of these models.`
                  : `One ${label} API key unlocks all of these models. Add it above.`}
          </Text>

          <VoiceErrorList messages={controller.errors} />
        </ScrollView>
      )}

      {provider && cloud ? (
        <>
          <SpeechProviderKeyDrawer
            visible={controller.keyDrawerOpen}
            provider={provider}
            replacing={provider.keyConfigured === true}
            saving={controller.keyAction === 'saving'}
            error={controller.keyError}
            onClose={() => controller.setKeyDrawerOpen(false)}
            onSave={(apiKey) => void controller.saveKey(provider.id, apiKey)}
            onDraftChange={() => controller.setKeyError(null)}
          />
          <ConfirmModal
            visible={controller.confirmRemoveOpen}
            title={`Remove ${label} key?`}
            message={`${label} models stop working until you add a key again.`}
            confirmLabel="Remove"
            destructive
            onConfirm={() => void controller.removeKey(provider.id)}
            onCancel={() => controller.setConfirmRemoveOpen(false)}
          />
        </>
      ) : null}
    </View>
  )
}
