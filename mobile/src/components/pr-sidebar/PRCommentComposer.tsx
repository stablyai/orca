import { useRef, useState } from 'react'
import { Pressable } from 'react-native'
import { X } from 'lucide-react-native'
import { colors } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { isSubmittableCommentBody } from '../../session/pr-comment-actions'
import { MessageBox } from '../composer-input/MessageBox'
import { composerInputStyles } from '../composer-input/composer-input-styles'

type Props = {
  // Share plain-text composer across root comment, reply and edit.
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
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [body, setBody] = useState(initialBody ?? '')
  // Guard synchronously against double-submit before parent’s async submitting state rerenders.
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
    <MessageBox
      value={body}
      onChangeText={setBody}
      placeholder={placeholder}
      editable={!submitting}
      autoFocus={autoFocus}
      onSend={() => void submit()}
      canSend={isSubmittableCommentBody(body)}
      sending={submitting}
      sendAccessibilityLabel={submitLabel}
      leading={
        onCancel ? (
          <Pressable
            style={({ pressed }) => [
              composerInputStyles.ghostButton,
              pressed && composerInputStyles.pressed
            ]}
            onPress={onCancel}
            disabled={submitting}
            accessibilityRole="button"
            accessibilityLabel={t('common.cancel', 'Cancel')}
          >
            <X size={19} color={colors.textSecondary} strokeWidth={2} />
          </Pressable>
        ) : undefined
      }
    />
  )
}
