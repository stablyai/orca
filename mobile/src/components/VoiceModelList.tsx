import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { Check, Download, Trash2 } from 'lucide-react-native'
import { colors, motion, radii, spacing, textStyles } from '../theme/mobile-theme'
import {
  CLOUD_MODEL_NEEDS_KEY,
  dictationModelRowAction,
  isModelInFlight,
  type MobileSpeechModel,
  type MobileSpeechSetup
} from '../dictation/mobile-dictation-setup'
import { ListGroup } from './ui/ListGroup'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import { slideTransition } from './ui/transition-styles'

type Props = {
  setup: MobileSpeechSetup
  // Disabled mirrors desktop: the model list greys out when dictation is off.
  disabled: boolean
  busyAction: { modelId: string; type: 'download' | 'select' | 'delete' } | null
  onUseModel: (model: MobileSpeechModel) => void
  onDownload: (model: MobileSpeechModel) => void
  onDelete: (model: MobileSpeechModel) => void
}

function formatSize(bytes: number | null | undefined): string {
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
  const anyBusy = busyAction !== null
  return (
    <View style={disabled ? styles.disabled : undefined} pointerEvents={disabled ? 'none' : 'auto'}>
      <ListGroup style={styles.group}>
        {setup.models.map((model) => {
          const action = dictationModelRowAction(model, setup.selectedModelId)
          const rowBusy = busyAction?.modelId === model.id
          const selectBusy = rowBusy && busyAction?.type === 'select'
          const downloadBusy = rowBusy && busyAction?.type === 'download'
          const deleteBusy = rowBusy && busyAction?.type === 'delete'
          const progress = isModelInFlight(model) ? model.progress : null
          return (
            <View key={model.id} style={styles.row}>
              <View style={styles.info}>
                <View style={styles.titleRow}>
                  <Text style={styles.label} numberOfLines={1}>
                    {model.label}
                  </Text>
                  {model.recommended ? <Badge label="Recommended" tone="green" /> : null}
                </View>
                <Text style={styles.meta} numberOfLines={1}>
                  {modelMeta(model)}
                </Text>
                {progress != null ? (
                  <View style={styles.progressTrack}>
                    <View
                      style={[
                        styles.progressFill,
                        { width: `${Math.round(progress * 100)}%` },
                        slideTransition
                      ]}
                    />
                  </View>
                ) : null}
              </View>
              {action === 'needs-api-key' ? (
                <Text style={styles.stateText} numberOfLines={2}>
                  {CLOUD_MODEL_NEEDS_KEY}
                </Text>
              ) : action === 'in-use' || action === 'use' ? (
                <View style={styles.actions}>
                  {action === 'in-use' ? (
                    <View style={styles.inUse}>
                      <Check size={16} color={colors.statusGreen} strokeWidth={2.4} />
                      <Text style={styles.inUseText}>In use</Text>
                    </View>
                  ) : (
                    <Button
                      label="Use"
                      size="compact"
                      busy={selectBusy}
                      disabled={anyBusy && !selectBusy}
                      accessibilityLabel={`Use ${model.label}`}
                      onPress={() => onUseModel(model)}
                    />
                  )}
                  {/* A cloud model has nothing on this computer to delete. */}
                  {model.provider === 'openai' ? null : deleteBusy ? (
                    <View style={styles.spinnerBox}>
                      <ActivityIndicator size="small" color={colors.danger} />
                    </View>
                  ) : (
                    <IconButton
                      icon={Trash2}
                      variant="bare"
                      iconSize={18}
                      iconColor={colors.danger}
                      disabled={anyBusy}
                      accessibilityLabel={`Delete ${model.label}`}
                      onPress={() => onDelete(model)}
                    />
                  )}
                </View>
              ) : action === 'downloading' ? (
                <View style={styles.spinnerBox}>
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                </View>
              ) : (
                <Button
                  label="Download"
                  icon={Download}
                  size="compact"
                  busy={downloadBusy}
                  disabled={anyBusy && !downloadBusy}
                  accessibilityLabel={`Download ${model.label}`}
                  onPress={() => onDownload(model)}
                />
              )}
            </View>
          )
        })}
      </ListGroup>
    </View>
  )
}

const styles = StyleSheet.create({
  disabled: { opacity: motion.disabledOpacity },
  // Why: the sheet already pads 12; the group adds 4 so rows sit 16 from the sheet edge.
  group: { marginHorizontal: spacing.xs },
  row: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: 10,
    paddingLeft: spacing.lg,
    paddingRight: spacing.sm
  },
  info: { flex: 1, minWidth: 0, gap: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  label: { ...textStyles.body, fontWeight: '500', color: colors.textPrimary, flexShrink: 1 },
  meta: { ...textStyles.subhead, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
  progressTrack: {
    height: 4,
    marginTop: spacing.xs,
    borderRadius: radii.pill,
    backgroundColor: colors.fill,
    overflow: 'hidden'
  },
  progressFill: { height: '100%', borderRadius: radii.pill, backgroundColor: colors.accentBlue },
  stateText: {
    ...textStyles.footnote,
    color: colors.textMuted,
    flexShrink: 1,
    maxWidth: 140,
    textAlign: 'right',
    paddingRight: spacing.sm
  },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  inUse: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm
  },
  inUseText: { ...textStyles.subhead, fontWeight: '500', color: colors.statusGreen },
  spinnerBox: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }
})
