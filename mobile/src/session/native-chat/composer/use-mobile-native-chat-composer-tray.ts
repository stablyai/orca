import {
  createElement,
  Fragment,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from 'react'
import type { TextInput } from 'react-native'
import { MobileNativeChatBackgroundTasks } from '../input/MobileNativeChatBackgroundTasks'
import { MobileNativeChatDockedTaskList } from '../input/MobileNativeChatDockedTaskList'
import type { NativeChatTaskList } from '../../../../../src/shared/native-chat/input/native-chat-task-list'
import {
  MobileNativeChatQueuedMessages,
  mobileNativeChatChordHeadId,
  type MobileNativeChatQueuedMessagesHandle,
  type MobileNativeChatQueuedMessagesProps
} from '../input/MobileNativeChatQueuedMessages'
import type { MobileStructuredBackgroundTasks } from '../../use-mobile-structured-background-tasks'
import { useMobileNativeChatQueuedEditFocus } from '../input/use-mobile-native-chat-queued-edit-focus'

/** The head queued card as an empty Cmd/Ctrl+Enter reaches it. */
export type MobileNativeChatSteerHead = {
  /** Whether the chord would press it now, read from the rendered queue. */
  steers: (alternateSteers: boolean) => boolean
  /** Runs its own Steer or Send; false where that press is unavailable. */
  run: (alternateSteers: boolean) => boolean
  /** Lights it while the composer previews sending it. */
  light: (lit: boolean) => void
}

export type MobileNativeChatComposerTray = {
  content?: ReactNode
  composerInputRef?: RefObject<TextInput | null>
  steerHead?: MobileNativeChatSteerHead
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
  const run = useCallback(
    (alternateSteers: boolean) => queuedRef.current?.steerHead(alternateSteers) ?? false,
    []
  )
  // Held here, not in the list, so a chat switch mid-preview mounts the new list already lit.
  const [headLit, light] = useState(false)
  const [busy, setBusy] = useState<{ sessionKey: string; ids: ReadonlySet<string> } | null>(null)
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
  const busyIds = busy?.sessionKey === sessionKey ? busy.ids : undefined
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
          headLit,
          onBusyChange: (ids: ReadonlySet<string>) => setBusy({ sessionKey, ids: new Set(ids) }),
          agentWorking
        })
      ),
      composerInputRef,
      steerHead: {
        steers: (alternateSteers: boolean) => {
          const head = mobileNativeChatChordHeadId(
            { cards, steerHeld, agentWorking, editor },
            alternateSteers
          )
          // A card whose own action is on its way would refuse the press, as desktop hides it then.
          return head !== null && busyIds?.has(head) !== true
        },
        run,
        light
      }
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
      headLit,
      busyIds,
      run,
      light,
      agentWorking
    ]
  )
}
