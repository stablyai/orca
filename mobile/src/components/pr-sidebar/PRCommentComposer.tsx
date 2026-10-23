import { useRef, useState } from 'react'
import { View } from 'react-native'
import { isSubmittableCommentBody } from '../../session/pr-comment-actions'
import { Button } from '../ui/Button'
import { ReplyBox } from '../ui/ReplyBox'
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

/** The chat composer's family at reply size, with an optional plain Cancel under it. */
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
      <ReplyBox
        value={body}
        onChangeText={setBody}
        onSend={() => void submit()}
        placeholder={placeholder}
        sendAccessibilityLabel={submitLabel}
        sending={submitting}
        autoFocus={autoFocus}
      />
      {onCancel ? (
        <View style={styles.actions}>
          <Button
            label="Cancel"
            variant="plain"
            size="compact"
            onPress={onCancel}
            disabled={submitting}
          />
        </View>
      ) : null}
    </View>
  )
}
