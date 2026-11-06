import {
  createElement,
  Fragment,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject
} from 'react'
import type { TextInput } from 'react-native'
import { MobileNativeChatBackgroundTasks } from '../input/MobileNativeChatBackgroundTasks'
import { MobileNativeChatDockedTaskList } from '../input/MobileNativeChatDockedTaskList'
import type { NativeChatTaskList } from '../../../../../src/shared/native-chat/input/native-chat-task-list'
import {
  MobileNativeChatQueuedMessages,
  type MobileNativeChatQueuedMessagesHandle,
  type MobileNativeChatQueuedMessagesProps
} from '../input/MobileNativeChatQueuedMessages'
import type { MobileStructuredBackgroundTasks } from '../../use-mobile-structured-background-tasks'
import { useMobileNativeChatQueuedEditFocus } from '../input/use-mobile-native-chat-queued-edit-focus'

export type MobileNativeChatComposerTray = {
  content?: ReactNode
  composerInputRef?: RefObject<TextInput | null>
  /** Runs the head queued card's own Steer or Send for an empty Cmd/Ctrl+Enter; false where it may not. */
  steerHead?: (alternateSteers: boolean) => boolean
}

export type ComposerTrayProps = {
  composerTray?: MobileNativeChatComposerTray
}

// Reuse the empty tray so its default cannot trigger rerenders.
export const NO_COMPOSER_TRAY: MobileNativeChatComposerTray = {}

export function useMobileNativeChatComposerTray({
  queued,
  taskList,
  backgroundTasks
}: {
  queued: MobileNativeChatQueuedMessagesProps & {
    /** One card list per conversation: a pending action in one never disables another's. */
    sessionKey: string
  }
  taskList: NativeChatTaskList | null
  backgroundTasks: MobileStructuredBackgroundTasks | null
}): MobileNativeChatComposerTray {
  const { composerInputRef, editQueuedMessage } = useMobileNativeChatQueuedEditFocus(queued.onEdit)
  const queuedRef = useRef<MobileNativeChatQueuedMessagesHandle>(null)
  const steerHead = useCallback(
    (alternateSteers: boolean) => queuedRef.current?.steerHead(alternateSteers) ?? false,
    []
  )
  const {
    cards,
    onSend,
    onDelete,
    onClearAll,
    editor,
    onMove,
    pause,
    onResume,
    sessionKey,
    steerHeld,
    agentWorking
  } = queued
  return useMemo(
    () => ({
      content: createElement(
        Fragment,
        null,
        taskList
          ? createElement(MobileNativeChatDockedTaskList, {
              key: `${sessionKey}:docked-task-list`,
              list: taskList,
              conversationKey: sessionKey
            })
          : null,
        backgroundTasks
          ? // Use distinct conversation keys so pending actions stay scoped and each tray section survives changes to the other.
            createElement(MobileNativeChatBackgroundTasks, {
              key: `${backgroundTasks.sessionKey}:background-tasks`,
              tasks: backgroundTasks
            })
          : null,
        createElement(MobileNativeChatQueuedMessages, {
          key: sessionKey,
          ref: queuedRef,
          cards,
          onSend,
          onDelete,
          onClearAll,
          onEdit: editQueuedMessage,
          editor,
          onMove,
          pause,
          onResume,
          steerHeld,
          agentWorking
        })
      ),
      composerInputRef,
      steerHead
    }),
    [
      taskList,
      backgroundTasks,
      cards,
      composerInputRef,
      editQueuedMessage,
      editor,
      onMove,
      onDelete,
      onClearAll,
      onResume,
      onSend,
      pause,
      sessionKey,
      steerHeld,
      steerHead,
      agentWorking
    ]
  )
}
