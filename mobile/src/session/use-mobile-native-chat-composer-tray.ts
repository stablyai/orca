// The region between the transcript and the composer, built outside the chat view: the session's
// running child work, then its queued-draft cards, and the composer ref a card's Edit focuses.

import { createElement, Fragment, useMemo, type ReactNode, type RefObject } from 'react'
import type { TextInput } from 'react-native'
import { MobileNativeChatBackgroundTasks } from './MobileNativeChatBackgroundTasks'
import {
  MobileNativeChatQueuedMessages,
  type MobileNativeChatQueuedMessagesProps
} from './MobileNativeChatQueuedMessages'
import type { MobileStructuredBackgroundTasks } from './use-mobile-structured-background-tasks'
import { useMobileNativeChatQueuedEditFocus } from './use-mobile-native-chat-queued-edit-focus'

export type MobileNativeChatComposerTray = {
  content?: ReactNode
  composerInputRef?: RefObject<TextInput | null>
}

export type ComposerTrayProps = {
  /** Running child work and host-held queued drafts, drawn between transcript and composer. */
  composerTray?: MobileNativeChatComposerTray
}

/** A view given no tray draws nothing there; one stable object, so the default never re-renders. */
export const NO_COMPOSER_TRAY: MobileNativeChatComposerTray = {}

export function useMobileNativeChatComposerTray({
  queued,
  backgroundTasks
}: {
  queued: MobileNativeChatQueuedMessagesProps & {
    /** One card list per conversation: a pending action in one never disables another's. */
    sessionKey: string
  }
  /** Null off the structured lane, which publishes no child work. */
  backgroundTasks: MobileStructuredBackgroundTasks | null
}): MobileNativeChatComposerTray {
  const { composerInputRef, editQueuedMessage } = useMobileNativeChatQueuedEditFocus(queued.onEdit)
  const { cards, onSend, onDelete, pause, onResume, sessionKey, steerHeld } = queued
  return useMemo(
    () => ({
      content: createElement(
        Fragment,
        null,
        backgroundTasks
          ? // Keyed per conversation: one chat's open list or pending Stop never shows in another.
            // Its own suffix: the two never share a key, so each stays mounted as the other comes
            // and goes.
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
          onEdit: editQueuedMessage,
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
      onDelete,
      onResume,
      onSend,
      pause,
      sessionKey,
      steerHeld
    ]
  )
}
