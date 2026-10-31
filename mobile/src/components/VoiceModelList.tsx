import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { Check, Download, Trash2 } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { Translate } from '../i18n/mobile-i18n'
import { getUiIntlLocale } from '../i18n/ui-intl-locale'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import {
  cloudModelNeedsKey,
  dictationModelRowAction,
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

function formatSize(bytes: number | null | undefined, t: Translate): string {
  if (!bytes) {
    return ''
  }
  return t('components.voiceModelList.modelSize', '{{size}} MB', {
    size: Math.round(bytes / 1_000_000).toLocaleString(getUiIntlLocale())
  })
}

function modelMeta(model: MobileSpeechModel, t: Translate): string {
  if (model.provider === 'openai') {
    return 'OpenAI API'
  }
  const inFlight = isModelInFlight(model)
  if (inFlight && model.progress != null) {
    return t('components.voiceModelList.modelProgress', '{{size}} · {{progress}}%', {
      size: formatSize(model.sizeBytes, t),
      progress: Math.round(model.progress * 100).toLocaleString(getUiIntlLocale())
    })
  }
  if (model.status === 'extracting') {
    return t('components.voiceModelList.modelExtracting', '{{size}} · extracting…', {
      size: formatSize(model.sizeBytes, t)
    })
  }
  return formatSize(model.sizeBytes, t)
}

// Share model size/progress/recommendation/selection/download/delete rows between setup and Voice settings.
export function VoiceModelList({
  setup,
  disabled,
  busyAction,
  onUseModel,
  onDownload,
  onDelete
}: Props): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <View style={disabled ? styles.disabled : undefined} pointerEvents={disabled ? 'none' : 'auto'}>
      {setup.models.map((model, idx) => {
        const anyBusy = busyAction !== null
        const action = dictationModelRowAction(model, setup.selectedModelId)
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
                  {model.recommended ? (
                    <Text style={styles.recommended}>
                      {t('components.voiceModelList.recommended', 'Recommended')}
                    </Text>
                  ) : null}
                </View>
                <Text style={styles.modelMeta}>{modelMeta(model, t)}</Text>
              </View>
              {action === 'needs-api-key' ? (
                <Text style={styles.modelStateText}>{cloudModelNeedsKey()}</Text>
              ) : action === 'in-use' || action === 'use' ? (
                <View style={styles.readyActions}>
                  {action === 'in-use' ? (
                    <View style={styles.selectedTag}>
                      <Check size={14} color={colors.statusGreen} strokeWidth={2.4} />
                      <Text style={styles.selectedText}>
                        {t('components.voiceModelList.inUse', 'In use')}
                      </Text>
                    </View>
                  ) : (
                    <Pressable
                      style={({ pressed }) => [
                        styles.actionButton,
                        pressed && styles.actionPressed
                      ]}
                      disabled={anyBusy}
                      accessibilityRole="button"
                      accessibilityLabel={t('components.voiceModelList.useModel', 'Use {{label}}', {
                        label: model.label
                      })}
                      accessibilityState={{ disabled: anyBusy }}
                      onPress={() => onUseModel(model)}
                    >
                      {selectBusy ? (
                        <ActivityIndicator size="small" color={colors.textSecondary} />
                      ) : (
                        <Text style={styles.actionText}>
                          {t('components.voiceModelList.use', 'Use')}
                        </Text>
                      )}
                    </Pressable>
                  )}
                  {/* A cloud model has nothing on this computer to delete. */}
                  {model.provider === 'openai' ? null : (
                    <Pressable
                      style={({ pressed }) => [styles.iconButton, pressed && styles.actionPressed]}
                      disabled={anyBusy}
                      onPress={() => onDelete(model)}
                      accessibilityLabel={t(
                        'components.voiceModelList.deleteModel',
                        'Delete {{label}}',
                        {
                          label: model.label
                        }
                      )}
                    >
                      {deleteBusy ? (
                        <ActivityIndicator size="small" color={colors.statusRed} />
                      ) : (
                        <Trash2 size={18} color={colors.statusRed} strokeWidth={2.2} />
                      )}
                    </Pressable>
                  )}
                </View>
              ) : action === 'downloading' ? (
                <ActivityIndicator size="small" color={colors.textSecondary} />
              ) : (
                <Pressable
                  style={({ pressed }) => [styles.iconButton, pressed && styles.actionPressed]}
                  disabled={anyBusy}
                  onPress={() => onDownload(model)}
                  accessibilityRole="button"
                  accessibilityLabel={t(
                    'components.voiceModelList.downloadModel',
                    'Download {{label}}',
                    {
                      label: model.label
                    }
                  )}
                  accessibilityState={{ disabled: anyBusy }}
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

const styles = themedStyleSheet(() => ({
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
  modelStateText: { color: colors.textMuted, fontSize: typography.metaSize, flexShrink: 1 },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radii.control,
    backgroundColor: colors.sheetGroup
  },
  actionPressed: { opacity: 0.7 },
  actionText: { color: colors.textSecondary, fontSize: typography.metaSize, fontWeight: '600' },
  iconButton: {
    width: 34,
    height: 34,
    borderRadius: radii.control,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.sheetGroup
  },
  readyActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  selectedTag: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  selectedText: { color: colors.statusGreen, fontSize: typography.metaSize, fontWeight: '600' },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  }
}))
