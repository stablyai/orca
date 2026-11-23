import { createElement, Fragment, useMemo, useState, type ReactNode, type RefObject } from 'react'
import type { TextInputInstance } from 'react-native'
import { MobileNativeChatBackgroundTasks } from '../../input/tasks/MobileNativeChatBackgroundTasks'
import { MobileNativeChatDockedTaskList } from '../../input/tasks/MobileNativeChatDockedTaskList'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import type { NativeChatTaskList } from '../../../../../../src/shared/native-chat/input/task-lists/native-chat-task-list'
import {
  MobileNativeChatQueuedMessages,
  mobileNativeChatChordHeadId,
  type MobileNativeChatQueuedMessagesProps
} from '../../input/queued-messages/MobileNativeChatQueuedMessages'
import type { MobileStructuredBackgroundTasks } from '../../input/tasks/use-mobile-structured-background-tasks'
import { useMobileNativeChatQueuedEditFocus } from '../../input/queued-messages/use-mobile-native-chat-queued-edit-focus'
import { createMobileQueuedHeadLight } from '../../input/queued-messages/mobile-queued-head-light'
import type { MobileWaitingAgentMailActionsValue } from '../../transcript/agent-messages/MobileWaitingAgentMailActions'
import {
  createMobileQueuedCardActionStore,
  useMobileQueuedCardActions
} from '../../input/queued-messages/mobile-queued-card-actions'

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
  composerInputRef?: RefObject<TextInputInstance | null>
  steerHead?: MobileNativeChatSteerHead
  /** Steer and Delete on other agents' waiting mail, which the transcript draws instead of a card. */
  waitingAgentMail?: MobileWaitingAgentMailActionsValue
}

export type ComposerTrayProps = {
  composerTray?: MobileNativeChatComposerTray
}

const NO_ROWS: readonly NativeChatMessage[] = []

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
    /** Other agents' waiting mail, which the transcript draws instead of a card. */
    agentMail?: readonly NativeChatMessage[]
    agentMailEditable?: (messageId: string) => boolean
  }
  taskList: NativeChatTaskList | null
  backgroundTasks: MobileStructuredBackgroundTasks | null
}): MobileNativeChatComposerTray {
  const { composerInputRef, editQueuedMessage } = useMobileNativeChatQueuedEditFocus(queued.onEdit)
  // Held here, not in the list, so a chat switch mid-preview mounts the new list already lit.
  const [headLight] = useState(createMobileQueuedHeadLight)
  const [actionStore] = useState(createMobileQueuedCardActionStore)
  const {
    cards,
    steerOrder = cards,
    onSend,
    onDelete,
    onClearAll,
    clearIds,
    editor,
    onMove,
    pause,
    onResume,
    sessionKey,
    steerHeld,
    agentWorking,
    agentMail,
    agentMailEditable
  } = queued
  const actions = useMobileQueuedCardActions(actionStore, sessionKey)
  // Its own memo, so the transcript's waiting rows redraw only when the mail or its actions change.
  const waitingAgentMail = useMemo(
    () =>
      // A list without the chat's queue actions draws no waiting mail.
      onSend && onDelete
        ? {
            rows: agentMail ?? NO_ROWS,
            actions,
            send: onSend,
            delete: onDelete,
            edit: editQueuedMessage,
            editable: agentMailEditable,
            steerHeld: steerHeld === true,
            agentWorking: agentWorking === true
          }
        : undefined,
    [
      agentMail,
      actions,
      onSend,
      onDelete,
      editQueuedMessage,
      agentMailEditable,
      steerHeld,
      agentWorking
    ]
  )
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
          actions,
          cards,
          onSend,
          onDelete,
          onClearAll,
          clearIds,
          onEdit: editQueuedMessage,
          editor,
          onMove,
          pause,
          onResume,
          steerHeld,
          headLight,
          agentWorking,
          steerOrder
        })
      ),
      composerInputRef,
      // Shares the cards' action guard, so a press here and on a card never overlap.
      waitingAgentMail,
      steerHead: {
        steers: (alternateSteers: boolean) => {
          const head = mobileNativeChatChordHeadId(
            { cards: steerOrder, steerHeld, agentWorking, editor },
            alternateSteers
          )
          // A card whose own action is on its way would refuse the press, as desktop hides it then.
          return head !== null && !actions.busyIds.has(head)
        },
        run: (alternateSteers: boolean) => {
          const head = mobileNativeChatChordHeadId(
            { cards: steerOrder, steerHeld, agentWorking, editor },
            alternateSteers
          )
          return head !== null && actions.run(head, onSend)
        },
        light: headLight.set
      }
    }),
    [
      taskList,
      backgroundTasks,
      cards,
      steerOrder,
      composerInputRef,
      editQueuedMessage,
      editor,
      onMove,
      onDelete,
      onClearAll,
      clearIds,
      onResume,
      onSend,
      pause,
      sessionKey,
      steerHeld,
      headLight,
      actions,
      agentWorking,
      waitingAgentMail
    ]
  )
}
