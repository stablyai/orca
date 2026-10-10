import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { AudioLines, Check, Download, Trash2 } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import {
  VOICE_BADGE_MAX_FONT_SCALE,
  voiceCabinetHitSlop,
  voiceCabinetStyles as styles
} from './voice-cabinet-styles'
import {
  formatSpeechModelSize,
  isSpeechModelDownloadable,
  isSpeechModelInFlight,
  isSpeechModelUsable,
  speechModelLabel,
  speechModelProgressText
} from '../dictation/speech-provider-presentation'
import type { MobileSpeechProviderModel } from '../dictation/speech-provider-reply-schema'

export type SpeechModelBusyAction = 'select' | 'download' | 'delete'

type Props = {
  model: MobileSpeechProviderModel
  local: boolean
  selected: boolean
  busy: SpeechModelBusyAction | null
  /** Another row's action is in flight; this row's buttons wait for it. */
  locked: boolean
  /** The provider's kind is unknown to this build: its models are shown, never selected. */
  readOnly?: boolean
  /** 'picker' selects on row tap and marks the choice; 'manage' shows Use / In use and Delete. */
  variant: 'picker' | 'manage'
  onSelect: () => void
  onDownload: () => void
  onDelete?: () => void
}

export function SpeechModelLivePill() {
  return (
    <View style={styles.livePill} accessibilityLabel="Live captions">
      <AudioLines size={10} color={colors.textSecondary} strokeWidth={2.4} />
      <Text style={styles.livePillText} maxFontSizeMultiplier={VOICE_BADGE_MAX_FONT_SCALE}>
        LIVE
      </Text>
    </View>
  )
}

function modelMetaText(model: MobileSpeechProviderModel, local: boolean): string {
  const progress = speechModelProgressText(model)
  if (progress) {
    return progress
  }
  if (model.status === 'error') {
    return 'Download failed. Tap download to retry.'
  }
  const size = local ? formatSpeechModelSize(model.sizeBytes) : ''
  return [size, model.description].filter(Boolean).join(' · ')
}

export function SpeechModelRow(props: Props) {
  const { model, local, selected, locked, readOnly = false, variant, onSelect } = props
  const usable = isSpeechModelUsable(model)
  const selectable = usable && !readOnly
  const meta = modelMetaText(model, local)
  const rowTappable = variant === 'picker' && selectable && !selected && !locked
  const content = (
    <>
      <View style={styles.modelInfo}>
        <View style={styles.rowTitleLine}>
          <Text style={styles.modelLabel} numberOfLines={1}>
            {speechModelLabel(model)}
          </Text>
          {model.realtime ? <SpeechModelLivePill /> : null}
          {model.recommended ? (
            <Text style={styles.recommended} maxFontSizeMultiplier={VOICE_BADGE_MAX_FONT_SCALE}>
              Recommended
            </Text>
          ) : null}
        </View>
        {meta ? (
          <Text
            style={[styles.modelMeta, model.status === 'error' && styles.modelMetaError]}
            numberOfLines={2}
          >
            {meta}
          </Text>
        ) : null}
      </View>
      <SpeechModelRowAction {...props} usable={usable} />
    </>
  )
  // Why: an accessible Pressable merges its children, hiding nested Use/Delete from VoiceOver.
  if (variant === 'manage') {
    return (
      <View
        style={[styles.modelRow, readOnly && !selected && styles.modelRowDimmed]}
        testID={`speech-model-${model.id}`}
      >
        {content}
      </View>
    )
  }
  return (
    <Pressable
      style={({ pressed }) => [
        styles.modelRow,
        !selectable && styles.modelRowDimmed,
        pressed && rowTappable && styles.actionPressed
      ]}
      disabled={!rowTappable}
      onPress={onSelect}
      // Why: an undownloaded row carries its own Download button, which must stay reachable.
      accessible={usable}
      accessibilityRole="radio"
      aria-checked={selected}
      testID={`speech-model-${model.id}`}
    >
      {content}
    </Pressable>
  )
}

function SpeechModelRowAction({
  model,
  local,
  selected,
  busy,
  locked,
  readOnly,
  variant,
  usable,
  onSelect,
  onDownload,
  onDelete
}: Props & { usable: boolean }) {
  if (busy === 'select' && variant === 'picker') {
    return <ActivityIndicator size="small" color={colors.textSecondary} />
  }
  if (usable) {
    if (variant === 'picker') {
      return selected ? <Check size={18} color={colors.statusGreen} strokeWidth={2.4} /> : null
    }
    const deletable = local && onDelete !== undefined
    // Why: an empty actions wrapper still takes the row's gap and shifts the label.
    if (!selected && readOnly && !deletable) {
      return null
    }
    return (
      <View style={styles.rowActions}>
        {selected ? (
          <View style={styles.selectedTag}>
            <Check size={14} color={colors.statusGreen} strokeWidth={2.4} />
            <Text style={styles.selectedText}>In use</Text>
          </View>
        ) : readOnly ? null : (
          <Pressable
            style={({ pressed }) => [styles.actionButton, pressed && styles.actionPressed]}
            hitSlop={voiceCabinetHitSlop.actionButton}
            disabled={locked}
            onPress={onSelect}
            accessibilityRole="button"
            accessibilityLabel={'Use ' + speechModelLabel(model)}
          >
            {busy === 'select' ? (
              <ActivityIndicator size="small" color={colors.textSecondary} />
            ) : (
              <Text style={styles.actionText}>Use</Text>
            )}
          </Pressable>
        )}
        {deletable ? (
          <Pressable
            style={({ pressed }) => [styles.iconButton, pressed && styles.actionPressed]}
            hitSlop={voiceCabinetHitSlop.iconButton}
            disabled={locked}
            onPress={onDelete}
            accessibilityRole="button"
            accessibilityLabel={'Delete ' + speechModelLabel(model)}
          >
            {busy === 'delete' ? (
              <ActivityIndicator size="small" color={colors.statusRed} />
            ) : (
              <Trash2 size={17} color={colors.statusRed} strokeWidth={2.2} />
            )}
          </Pressable>
        ) : null}
      </View>
    )
  }
  // Why: one key unlocks every model of a provider, so the key prompt lives on the provider, not each row.
  if (!local) {
    return null
  }
  if (isSpeechModelInFlight(model)) {
    return <ActivityIndicator size="small" color={colors.textSecondary} />
  }
  if (!isSpeechModelDownloadable(model)) {
    return null
  }
  return (
    <Pressable
      style={({ pressed }) => [styles.iconButton, pressed && styles.actionPressed]}
      hitSlop={voiceCabinetHitSlop.iconButton}
      disabled={locked}
      onPress={onDownload}
      accessibilityRole="button"
      accessibilityLabel={'Download ' + speechModelLabel(model)}
    >
      {busy === 'download' ? (
        <ActivityIndicator size="small" color={colors.textSecondary} />
      ) : (
        <Download size={17} color={colors.textSecondary} strokeWidth={2.2} />
      )}
    </Pressable>
  )
}
