import { createElement, Fragment, useMemo, type ReactNode, type RefObject } from 'react'
import type { TextInput } from 'react-native'
import { MobileNativeChatBackgroundTasks } from '../input/MobileNativeChatBackgroundTasks'
import {
  MobileNativeChatQueuedMessages,
  type MobileNativeChatQueuedMessagesProps
} from '../input/MobileNativeChatQueuedMessages'
import type { MobileStructuredBackgroundTasks } from '../../use-mobile-structured-background-tasks'
import { useMobileNativeChatQueuedEditFocus } from '../input/use-mobile-native-chat-queued-edit-focus'

export type MobileNativeChatComposerTray = {
  content?: ReactNode
  composerInputRef?: RefObject<TextInput | null>
}

export type ComposerTrayProps = {
  composerTray?: MobileNativeChatComposerTray
}

// Reuse the empty tray so its default cannot trigger rerenders.
export const NO_COMPOSER_TRAY: MobileNativeChatComposerTray = {}

export function useMobileNativeChatComposerTray({
  queued,
  backgroundTasks
}: {
  queued: MobileNativeChatQueuedMessagesProps & {
    /** One card list per conversation: a pending action in one never disables another's. */
    sessionKey: string
  }
  backgroundTasks: MobileStructuredBackgroundTasks | null
}): MobileNativeChatComposerTray {
  const { composerInputRef, editQueuedMessage } = useMobileNativeChatQueuedEditFocus(queued.onEdit)
  const { cards, onSend, onDelete, onClearAll, editor, pause, onResume, sessionKey, steerHeld } =
    queued
  return useMemo(
    () => ({
      content: createElement(
        Fragment,
        null,
        backgroundTasks
          ? // Use distinct conversation keys so pending actions stay scoped and each tray section survives changes to the other.
            createElement(MobileNativeChatBackgroundTasks, {
              key: `${backgroundTasks.sessionKey}:background-tasks`,
              tasks: backgroundTasks
            })
          : null,
        createElement(MobileNativeChatQueuedMessages, {
          key: sessionKey,
          cards,
          onSend,
          onDelete,
          onClearAll,
          onEdit: editQueuedMessage,
          editor,
          pause,
          onResume,
          steerHeld
        })
      ),
      composerInputRef
    }),
    [
      backgroundTasks,
      cards,
      composerInputRef,
      editQueuedMessage,
      editor,
      onDelete,
      onClearAll,
      onResume,
      onSend,
      pause,
      sessionKey,
      steerHeld
    ]
  )
}
