import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { VoiceSettingsOperations } from './voice-settings-operations'
import { voiceSettingsStyles as styles } from './voice-settings-styles'
import { ChevronLeft, ChevronRight } from 'lucide-react-native'
import { colors, spacing } from '../theme/mobile-theme'
import { BottomDrawer } from '../components/BottomDrawer'
import { VoiceModelList } from '../components/VoiceModelList'
import { useVoiceSettingsController } from './use-voice-settings-controller'
import { VOICE_HOST_UNPAIRED_MESSAGE } from './voice-settings-host-selection'
import { VoiceDictationSection } from './voice-dictation-section'
import { VoiceCabinetSections } from './voice-cabinet-sections'
import { VoiceErrorList } from './voice-error-list'
import { SpeechModelPickerDrawer } from './speech-model-picker-drawer'
import { SpeechLanguagePickerDrawer } from './speech-language-picker-drawer'
import type { MobileSpeechProvider } from '../dictation/speech-provider-reply-schema'
import {
  findSelectedSpeechModel,
  speechModelLabel,
  speechModelLanguageSupport
} from '../dictation/speech-provider-presentation'

export default function VoiceSettingsScreen({
  operations,
  focused,
  unpaired = false,
  onBack,
  onOpenProvider,
  onOpenCloudProviders
}: {
  operations: VoiceSettingsOperations | null
  focused: boolean
  /** The session's desktop was unpaired; show that instead of another desktop's settings. */
  unpaired?: boolean
  onBack: () => void
  /** Opens the provider screen; absent where there is no router (tests). */
  onOpenProvider?: (providerId: string) => void
  onOpenCloudProviders?: () => void
}): React.JSX.Element {
  const insets = useSafeAreaInsets()
  const controller = useVoiceSettingsController(operations, focused)
  const { setup, cabinet, loading, error, busyAction } = controller
  const hasState = cabinet !== null || setup !== null
  const enabled = cabinet?.enabled ?? setup?.enabled ?? false
  const dictationMode = cabinet ? cabinet.dictationMode : setup?.dictationMode
  const selectedModelLabel =
    setup?.models.find((m) => m.id === setup.selectedModelId)?.label ?? 'None selected'
  const selectedCabinetModel = cabinet ? findSelectedSpeechModel(cabinet) : null
  const openProvider = (provider: MobileSpeechProvider) => {
    controller.setModelDrawerOpen(false)
    onOpenProvider?.(provider.id)
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.backButton}
          onPress={onBack}
        >
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>Voice</Text>
      </View>

      {unpaired || (!hasState && !operations && focused) ? (
        <View style={[styles.section, styles.sectionTopGap]}>
          <Text style={styles.emptyText}>
            {unpaired
              ? VOICE_HOST_UNPAIRED_MESSAGE
              : 'Connect to a desktop to manage voice settings.'}
          </Text>
        </View>
      ) : !hasState && (loading || !operations || !error) ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.textSecondary} />
        </View>
      ) : !hasState ? (
        <View style={[styles.section, styles.sectionTopGap]}>
          <Text style={styles.errorText}>{error ?? 'Failed to load voice settings.'}</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <VoiceDictationSection
            enabled={enabled}
            dictationMode={dictationMode}
            onConfigure={(params) => void controller.configure(params)}
          />

          {cabinet ? (
            <VoiceCabinetSections
              state={cabinet}
              onOpenModelPicker={() => controller.setModelDrawerOpen(true)}
              onOpenLanguagePicker={() => controller.setLanguageDrawerOpen(true)}
              onOpenProvider={openProvider}
              onOpenCloudProviders={() => onOpenCloudProviders?.()}
            />
          ) : (
            <>
              <Text style={[styles.groupHeading, styles.inputGroupGap]}>SPEECH MODEL</Text>
              <View style={[styles.section, styles.sectionTopGap]}>
                <Pressable
                  style={({ pressed }) => [
                    styles.row,
                    !enabled && styles.disabled,
                    pressed && styles.rowPressed
                  ]}
                  disabled={!enabled}
                  testID="voice-model-picker"
                  onPress={() => controller.setModelDrawerOpen(true)}
                >
                  <View style={styles.rowContent}>
                    <Text style={styles.rowLabel}>Speech Model</Text>
                    <Text style={styles.rowSublabel} numberOfLines={1}>
                      {selectedModelLabel}
                    </Text>
                  </View>
                  <ChevronRight size={18} color={colors.textMuted} />
                </Pressable>
              </View>
            </>
          )}

          <VoiceErrorList messages={controller.errors} />
        </ScrollView>
      )}

      {cabinet ? (
        <>
          <SpeechModelPickerDrawer
            visible={controller.modelDrawerOpen}
            state={cabinet}
            busy={busyAction}
            onClose={() => controller.setModelDrawerOpen(false)}
            onSelect={(model) => void controller.selectModel(model.id)}
            onDownload={(model) => void controller.downloadModel(model.id)}
            onOpenProvider={openProvider}
          />
          <SpeechLanguagePickerDrawer
            visible={controller.languageDrawerOpen}
            language={cabinet.language}
            support={speechModelLanguageSupport(selectedCabinetModel?.model)}
            modelLabel={selectedCabinetModel ? speechModelLabel(selectedCabinetModel.model) : null}
            onClose={() => controller.setLanguageDrawerOpen(false)}
            onSelect={(code) => void controller.setLanguage(code)}
          />
        </>
      ) : (
        <BottomDrawer
          visible={controller.modelDrawerOpen}
          onClose={() => controller.setModelDrawerOpen(false)}
        >
          <Text style={styles.drawerTitle}>Speech Model</Text>
          {setup ? (
            <VoiceModelList
              setup={setup}
              disabled={false}
              busyAction={busyAction}
              onUseModel={(m) => void controller.selectModel(m.id)}
              onDownload={(m) => void controller.downloadModel(m.id)}
              onDelete={(m) => void controller.deleteModel(m.id)}
            />
          ) : null}
        </BottomDrawer>
      )}
    </View>
  )
}
