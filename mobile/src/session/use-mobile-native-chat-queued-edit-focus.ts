import type { TextInputInstance } from 'react-native'
import { useMemo, useRef, type RefObject } from 'react'
import type { MobileQueuedMessageEdit } from './use-mobile-structured-queued-message-controls'

/** Wraps a queued card's Edit so the composer it fills takes focus, and typing continues
 *  without another tap. An Edit that copied nothing leaves focus where it is. */
export function useMobileNativeChatQueuedEditFocus(onEdit: MobileQueuedMessageEdit | undefined): {
  composerInputRef: RefObject<TextInputInstance | null>
  editQueuedMessage: MobileQueuedMessageEdit | undefined
} {
  const composerInputRef = useRef<TextInputInstance>(null)
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
