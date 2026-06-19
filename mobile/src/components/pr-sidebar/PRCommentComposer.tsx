import { useRef, useState } from 'react'
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native'
import { colors } from '../../theme/mobile-theme'
import { isSubmittableCommentBody } from '../../session/pr-comment-actions'
import { prCommentComposerStyles as styles } from './pr-comment-composer-styles'

type Props = {
  // Plain-text composer shared by the reply affordance, the root-comment box, and
  // the inline edit editor.
  placeholder: string
  submitLabel: string
  submitting: boolean
  // Seeds the field for the edit case; the reply/add cases leave it empty.
  initialBody?: string
  // Resolves to true on success; the composer clears + collapses (caller-driven via key remount or onSubmitted).
  onSubmit: (body: string) => Promise<boolean>
  onCancel?: () => void
  autoFocus?: boolean
}

export function PRCommentComposer({
  placeholder,
  submitLabel,
  submitting,
  initialBody,
  onSubmit,
  onCancel,
  autoFocus
}: Props) {
  const [body, setBody] = useState(initialBody ?? '')
  // Why: parent `submitting` flips async; a fast double-tap can fire onSubmit
  // twice before it flips, so guard locally in the same synchronous tick.
  const inFlightRef = useRef(false)
  const canSubmit = isSubmittableCommentBody(body) && !submitting

  const submit = async () => {
    if (!canSubmit || inFlightRef.current) {
      return
    }
    inFlightRef.current = true
    try {
      const ok = await onSubmit(body.trim())
      if (ok) {
        setBody('')
      }
    } finally {
      inFlightRef.current = false
    }
  }

  return (
    <View style={styles.container}>
      <TextInput
        style={styles.input}
        value={body}
        onChangeText={setBody}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        multiline
        editable={!submitting}
        autoFocus={autoFocus}
      />
      <View style={styles.actions}>
        {onCancel ? (
          <Pressable
            style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}
            onPress={onCancel}
            disabled={submitting}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        ) : null}
        <Pressable
          style={({ pressed }) => [
            styles.submit,
            !canSubmit && styles.submitDisabled,
            pressed && styles.pressed
          ]}
          onPress={() => void submit()}
          disabled={!canSubmit}
          accessibilityRole="button"
          accessibilityLabel={submitLabel}
        >
          {submitting ? (
            <ActivityIndicator size="small" color={colors.bgBase} />
          ) : (
            <Text style={styles.submitText}>{submitLabel}</Text>
          )}
        </Pressable>
      </View>
    </View>
  )
}
