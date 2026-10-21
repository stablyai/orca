import { useMemo, useRef, type RefObject } from 'react'
import type { TextInput } from 'react-native'
import type { MobileQueuedMessageEdit } from './use-mobile-structured-queued-message-controls'

/** Wraps a queued card's Edit so the composer it fills takes focus, and typing continues
 *  without another tap. An Edit that copied nothing leaves focus where it is. */
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
