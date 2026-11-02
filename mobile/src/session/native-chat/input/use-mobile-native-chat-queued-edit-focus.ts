import { useMemo, useRef, type RefObject } from 'react'
import type { TextInput } from 'react-native'
import type { MobileQueuedMessageEdit } from '../../use-mobile-structured-queued-message-controls'

// Focus after a queued Edit actually copies text; empty copies preserve current focus.
export function useMobileNativeChatQueuedEditFocus(onEdit: MobileQueuedMessageEdit | undefined): {
  composerInputRef: RefObject<TextInput | null>
  editQueuedMessage: MobileQueuedMessageEdit | undefined
} {
  const composerInputRef = useRef<TextInput>(null)
  const editQueuedMessage = useMemo<MobileQueuedMessageEdit | undefined>(
    () =>
      onEdit
        ? (messageId) =>
            onEdit(messageId, () =>
              // Next frame, so the copied text has landed in the field before it takes focus.
              requestAnimationFrame(() => composerInputRef.current?.focus())
            )
        : undefined,
    [onEdit]
  )
  return { composerInputRef, editQueuedMessage }
}
