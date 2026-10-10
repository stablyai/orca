import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { Check, Download } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { isModelInFlight, type MobileSpeechSetup } from '../dictation/mobile-dictation-setup'

type Props = {
  model: MobileSpeechSetup['models'][number]
  selected: boolean
  busy: boolean
  onUse: () => void
  onDownload: () => void
}

function formatSize(bytes: number | null | undefined): string {
  if (!bytes) {
    return ''
  }
  return `${Math.round(bytes / 1_000_000)} MB`
}

/** One model row of the setup sheet on desktops without the provider cabinet. */
export function MobileDictationLegacyModelRow({
  model,
  selected,
  busy,
  onUse,
  onDownload
}: Props): React.JSX.Element {
  const inFlight = isModelInFlight(model)
  return (
    <View style={styles.modelRow}>
      <View style={styles.modelInfo}>
        <View style={styles.modelTitleRow}>
          <Text style={styles.modelLabel}>{model.label}</Text>
          {model.recommended ? <Text style={styles.recommended}>Recommended</Text> : null}
        </View>
        <Text style={styles.modelMeta}>
          {model.provider === 'openai' ? 'OpenAI API' : formatSize(model.sizeBytes)}
          {inFlight && model.progress != null
            ? ` · ${Math.round(model.progress * 100)}%`
            : model.status === 'extracting'
              ? ' · extracting…'
              : ''}
        </Text>
      </View>
      {model.provider === 'openai' ? (
        <Text style={styles.modelStateText}>
          {model.status === 'ready' ? 'API key set' : 'Set up on desktop'}
        </Text>
      ) : model.status === 'ready' ? (
        selected ? (
          <View style={styles.selectedTag}>
            <Check size={14} color={colors.statusGreen} strokeWidth={2.4} />
            <Text style={styles.selectedText}>In use</Text>
          </View>
        ) : (
          <Pressable
            style={({ pressed }) => [styles.actionButton, pressed && styles.actionPressed]}
            disabled={busy}
            onPress={onUse}
          >
            <Text style={styles.actionText}>Use</Text>
          </Pressable>
        )
      ) : inFlight ? (
        <ActivityIndicator size="small" color={colors.textSecondary} />
      ) : (
        <Pressable
          style={({ pressed }) => [styles.actionButton, pressed && styles.actionPressed]}
          disabled={busy}
          onPress={onDownload}
        >
          {busy ? (
            <ActivityIndicator size="small" color={colors.textSecondary} />
          ) : (
            <>
              <Download size={13} color={colors.textSecondary} strokeWidth={2.2} />
              <Text style={styles.actionText}>Download</Text>
            </>
          )}
        </Pressable>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  modelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.sm
  },
  modelInfo: { flex: 1, minWidth: 0 },
  modelTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  modelLabel: { color: colors.textPrimary, fontSize: typography.bodySize },
  recommended: {
    color: colors.statusGreen,
    fontSize: 10,
    fontWeight: '700'
  },
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
  selectedTag: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  selectedText: { color: colors.statusGreen, fontSize: typography.metaSize, fontWeight: '600' }
})
