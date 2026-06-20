import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { Check, Download, Trash2 } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import {
  isModelInFlight,
  type MobileSpeechModel,
  type MobileSpeechSetup
} from '../dictation/mobile-dictation-setup'

type Props = {
  setup: MobileSpeechSetup
  // Disabled mirrors desktop: the model list greys out when dictation is off.
  disabled: boolean
  busyAction: { modelId: string; type: 'download' | 'select' | 'delete' } | null
  onUseModel: (model: MobileSpeechModel) => void
  onDownload: (model: MobileSpeechModel) => void
  onDelete: (model: MobileSpeechModel) => void
}

function formatSize(bytes: number | null): string {
  if (!bytes) {
    return ''
  }
  return `${Math.round(bytes / 1_000_000)} MB`
}

function modelMeta(model: MobileSpeechModel): string {
  if (model.provider === 'openai') {
    return 'OpenAI API'
  }
  const inFlight = isModelInFlight(model)
  if (inFlight && model.progress != null) {
    return `${formatSize(model.sizeBytes)} · ${Math.round(model.progress * 100)}%`
  }
  if (model.status === 'extracting') {
    return `${formatSize(model.sizeBytes)} · extracting…`
  }
  return formatSize(model.sizeBytes)
}

// Renders the speech-model rows shared between the setup sheet and the Voice
// settings page: size/progress, recommended badge, selected check, download, delete.
export function VoiceModelList({
  setup,
  disabled,
  busyAction,
  onUseModel,
  onDownload,
  onDelete
}: Props): React.JSX.Element {
  return (
    <View style={disabled ? styles.disabled : undefined} pointerEvents={disabled ? 'none' : 'auto'}>
      {setup.models.map((model, idx) => {
        const anyBusy = busyAction !== null
        const isSelected = model.id === setup.selectedModelId
        const inFlight = isModelInFlight(model)
        const rowBusy = busyAction?.modelId === model.id
        const selectBusy = rowBusy && busyAction?.type === 'select'
        const downloadBusy = rowBusy && busyAction?.type === 'download'
        const deleteBusy = rowBusy && busyAction?.type === 'delete'
        return (
          <View key={model.id}>
            {idx > 0 && <View style={styles.separator} />}
            <View style={styles.modelRow}>
              <View style={styles.modelInfo}>
                <View style={styles.modelTitleRow}>
                  <Text style={styles.modelLabel} numberOfLines={1}>
                    {model.label}
                  </Text>
                  {model.recommended ? <Text style={styles.recommended}>Recommended</Text> : null}
                </View>
                <Text style={styles.modelMeta}>{modelMeta(model)}</Text>
              </View>
              {model.provider === 'openai' ? (
                <Text style={styles.modelStateText}>
                  {model.status === 'ready' ? 'API key set' : 'Set up on desktop'}
                </Text>
              ) : model.status === 'ready' ? (
                <View style={styles.readyActions}>
                  {isSelected ? (
                    <View style={styles.selectedTag}>
                      <Check size={14} color={colors.statusGreen} strokeWidth={2.4} />
                      <Text style={styles.selectedText}>In use</Text>
                    </View>
                  ) : (
                    <Pressable
                      style={({ pressed }) => [
                        styles.actionButton,
                        pressed && styles.actionPressed
                      ]}
                      disabled={anyBusy}
                      onPress={() => onUseModel(model)}
                    >
                      {selectBusy ? (
                        <ActivityIndicator size="small" color={colors.textSecondary} />
                      ) : (
                        <Text style={styles.actionText}>Use</Text>
                      )}
                    </Pressable>
                  )}
                  <Pressable
                    style={({ pressed }) => [styles.iconButton, pressed && styles.actionPressed]}
                    disabled={anyBusy}
                    onPress={() => onDelete(model)}
                    accessibilityLabel={'Delete ' + model.label}
                  >
                    {deleteBusy ? (
                      <ActivityIndicator size="small" color={colors.statusRed} />
                    ) : (
                      <Trash2 size={18} color={colors.statusRed} strokeWidth={2.2} />
                    )}
                  </Pressable>
                </View>
              ) : inFlight ? (
                <ActivityIndicator size="small" color={colors.textSecondary} />
              ) : (
                <Pressable
                  style={({ pressed }) => [styles.iconButton, pressed && styles.actionPressed]}
                  disabled={anyBusy}
                  onPress={() => onDownload(model)}
                  accessibilityLabel={'Download ' + model.label}
                >
                  {downloadBusy ? (
                    <ActivityIndicator size="small" color={colors.textSecondary} />
                  ) : (
                    <Download size={18} color={colors.textSecondary} strokeWidth={2.2} />
                  )}
                </Pressable>
              )}
            </View>
          </View>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  disabled: { opacity: 0.5 },
  modelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  modelInfo: { flex: 1, minWidth: 0 },
  modelTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  modelLabel: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '500',
    flexShrink: 1
  },
  recommended: { color: colors.statusGreen, fontSize: 10, fontWeight: '700' },
  modelMeta: { color: colors.textMuted, fontSize: typography.metaSize, marginTop: 2 },
  modelStateText: { color: colors.textMuted, fontSize: typography.metaSize },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised
  },
  actionPressed: { opacity: 0.7 },
  actionText: { color: colors.textSecondary, fontSize: typography.metaSize, fontWeight: '600' },
  iconButton: {
    width: 34,
    height: 34,
    borderRadius: radii.button,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised
  },
  readyActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  selectedTag: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  selectedText: { color: colors.statusGreen, fontSize: typography.metaSize, fontWeight: '600' },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  }
})
