import { useCallback, type MutableRefObject } from 'react'
import type {
  HostSessionNativeChatOperations,
  HostSessionNativeChatTarget
} from './host-session-native-chat-operations'
import {
  openMobileNativeChatSendBudget,
  type MobileNativeChatSendOutcome
} from './mobile-native-chat-send'
import type { CatalogCommandDelivery } from '../../../src/shared/agent-session-option-catalog'
import { isSlashCommandDraft } from '../../../src/shared/native-chat-slash-commands'
import { classifyMobileNativeChatSend } from './mobile-native-chat-send-classification'
import {
  acquireMobileNativeChatTerminalWrite,
  releaseMobileNativeChatTerminalWrite
} from './mobile-native-chat-terminal-write-lock'
import type { MobileNativeChatSendOrigin } from './use-mobile-native-chat-drafts'
import type { MobileNativeChatLaunchDraftSeed } from './use-mobile-native-chat-launch-draft-seed'
import { buildAgentTuiClearInputForText } from '../../../src/shared/agent-tui-input-clear'

export type MobileNativeChatMessageSend = {
  send: (text: string, images?: string[]) => Promise<boolean>
  /** Outcome-preserving variant: callers that pasted terminal input beforehand
   *  (image sends) must see 'unknown' to heal a possibly-orphaned paste. Such a
   *  caller passes its own `deadline` so the paste it already spent and this text
   *  body share one budget instead of holding the composer for two. */
  sendWithOutcome: (
    text: string,
    images?: string[],
    deadline?: number
  ) => Promise<MobileNativeChatSendOutcome>
  /** Answer to an agent question — never touches the composer draft. */
  answerQuestion: (text: string) => Promise<boolean>
  /** Session-option command dispatch (e.g. `/model sonnet`) — never touches the
   *  composer draft; callers need the outcome to track dispatched state. */
  dispatchCommand: (
    text: string,
    options?: { delivery?: CatalogCommandDelivery }
  ) => Promise<MobileNativeChatSendOutcome>
}

export function useMobileNativeChatMessageSend(args: {
  operations: HostSessionNativeChatOperations | null
  enabled: boolean
  targetRef: MutableRefObject<HostSessionNativeChatTarget | null>
  agentRef: MutableRefObject<string | null>
  commandSendRef: MutableRefObject<(command: string) => void>
  captureSendOrigin: (text: string) => MobileNativeChatSendOrigin | null
  /** Launch-context text Orca parked on the agent's TUI input line, or null. Read
   *  at send time so the pre-clear can be sized to every line it occupies. */
  readSeededLaunchDraftSeed: () => MobileNativeChatLaunchDraftSeed | null
  clearDraftForSend: (origin: MobileNativeChatSendOrigin, text: string) => void
  restoreRejectedDraft: (origin: MobileNativeChatSendOrigin, text: string) => void
  acceptSend: (origin: MobileNativeChatSendOrigin, text: string, images?: string[]) => void
  holdUnconfirmedSend: (
    origin: MobileNativeChatSendOrigin,
    text: string,
    onUnconfirmed: () => void
  ) => void
  onSendError: (message: string) => void
}): MobileNativeChatMessageSend {
  const {
    operations,
    enabled,
    targetRef,
    agentRef,
    commandSendRef,
    captureSendOrigin,
    readSeededLaunchDraftSeed,
    clearDraftForSend,
    restoreRejectedDraft,
    acceptSend,
    holdUnconfirmedSend,
    onSendError
  } = args

  const sendMessage = useCallback(
    async (
      draftText: string,
      images: string[] | undefined,
      syncComposer: boolean,
      recordControlSend: boolean,
      sharedDeadline?: number
    ): Promise<MobileNativeChatSendOutcome> => {
      // The host writes trailing whitespace verbatim onto the agent's input line.
      const text = draftText.trimEnd()
      const target = targetRef.current
      const origin = captureSendOrigin(text)
      const agent = agentRef.current
      const recordCommand = commandSendRef.current
      if (!operations || !target || !origin || !enabled) {
        onSendError('Message not sent (disconnected)')
        return 'rejected'
      }
      // One budget spans stale-input healing and the committed message write.
      const deadline = sharedDeadline ?? openMobileNativeChatSendBudget()
      if (!(await operations.prepareCommit(target, deadline))) {
        onSendError('Message not sent')
        return 'rejected'
      }
      if (syncComposer) {
        clearDraftForSend(origin, draftText)
      }
      const seededLaunchDraft = readSeededLaunchDraftSeed()
      if (seededLaunchDraft && !images?.length) {
        const clearOutcome = await operations.respond(
          target,
          buildAgentTuiClearInputForText(seededLaunchDraft.text),
          false,
          deadline
        )
        if (clearOutcome !== 'accepted') {
          if (syncComposer) {
            restoreRejectedDraft(origin, draftText)
          }
          onSendError('Message not sent')
          return 'rejected'
        }
      }
      const classification = classifyMobileNativeChatSend(agent, text)
      const resolvedLaunchDraft =
        syncComposer && typeof seededLaunchDraft?.createdAt === 'number'
          ? { text: seededLaunchDraft.text, createdAt: seededLaunchDraft.createdAt }
          : undefined
      const typeCommand =
        agent === 'codex' &&
        classification !== 'chat' &&
        isSlashCommandDraft(text) &&
        !images?.length
      const outcome = await operations.sendMessage(
        target,
        text,
        deadline,
        !images?.length && !seededLaunchDraft,
        resolvedLaunchDraft,
        typeCommand
      )
      if (outcome === 'unknown') {
        if (classification === 'chat') {
          holdUnconfirmedSend(origin, text, () =>
            onSendError('Delivery unconfirmed — check chat before retrying')
          )
        }
        return 'unknown'
      }
      if (outcome === 'rejected') {
        if (syncComposer) {
          restoreRejectedDraft(origin, draftText)
        }
        onSendError('Message not sent')
        return 'rejected'
      }
      if (classification === 'chat') {
        acceptSend(origin, text, images)
      } else if (recordControlSend) {
        recordCommand(text.trim())
      }
      return 'accepted'
    },
    [
      acceptSend,
      agentRef,
      captureSendOrigin,
      clearDraftForSend,
      commandSendRef,
      enabled,
      holdUnconfirmedSend,
      onSendError,
      operations,
      readSeededLaunchDraftSeed,
      restoreRejectedDraft,
      targetRef
    ]
  )

  const sendWithOutcome = useCallback(
    (text: string, images?: string[], deadline?: number) =>
      sendMessage(text, images, true, true, deadline),
    [sendMessage]
  )
  const send = useCallback(
    async (text: string, images?: string[]) => (await sendWithOutcome(text, images)) !== 'rejected',
    [sendWithOutcome]
  )
  const answerQuestion = useCallback(
    async (text: string): Promise<boolean> => {
      const terminal = targetRef.current?.terminalId
      if (terminal && !acquireMobileNativeChatTerminalWrite(terminal)) {
        onSendError('Answer not sent')
        return false
      }
      try {
        return (await sendMessage(text, undefined, false, true)) !== 'rejected'
      } finally {
        if (terminal) {
          releaseMobileNativeChatTerminalWrite(terminal)
        }
      }
    },
    [onSendError, sendMessage, targetRef]
  )

  // A session-option apply writes to the same input line as a send, and the host
  // spaces a send's body and its Enter ~500ms apart — so without this lock an
  // apply lands between them and is submitted as part of the user's prompt.
  const dispatchCommand = useCallback(
    async (
      text: string,
      _options?: { delivery?: CatalogCommandDelivery }
    ): Promise<MobileNativeChatSendOutcome> => {
      const target = targetRef.current
      const terminal = target?.terminalId
      if (terminal && !acquireMobileNativeChatTerminalWrite(terminal)) {
        return 'rejected'
      }
      try {
        if (agentRef.current === 'codex') {
          if (!operations || !target || !terminal || !enabled) {
            return 'rejected'
          }
          const deadline = openMobileNativeChatSendBudget()
          if (!(await operations.prepareCommit(target, deadline))) {
            return 'rejected'
          }
          return operations.sendMessage(target, text, deadline, false, undefined, true)
        }
        return await sendMessage(text, undefined, false, false)
      } finally {
        if (terminal) {
          releaseMobileNativeChatTerminalWrite(terminal)
        }
      }
    },
    [agentRef, enabled, operations, sendMessage, targetRef]
  )

  return { send, sendWithOutcome, answerQuestion, dispatchCommand }
}
