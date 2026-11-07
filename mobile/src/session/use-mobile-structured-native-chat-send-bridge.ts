import { useCallback } from 'react'
import type { AgentSessionSlashCommand } from '../../../src/shared/agent-session/agent-session-wire'
import type { StructuredAgentId } from '../../../src/shared/agent-session/lifecycle/agent-session-provider-handle'

import type {
  MobileNativeChatSendIntent,
  MobileNativeChatSendOutcome
} from './native-chat/mobile-native-chat-send'
import type { MobileNativeChatSendOrigin } from './native-chat/mobile-native-chat-pending-echo'
import type { StructuredMobileSendAttachment } from './use-mobile-structured-send-with-outcome'
import type { AgentJournalSkillRef } from '../../../src/shared/agent-session/journal/agent-session-journal-types'
import {
  readMobileNativeChatPickedSkills,
  restoreMobileNativeChatPickedSkills
} from './native-chat/composer/mobile-native-chat-draft-store'
import {
  beginMobileNativeChatInFlightSend,
  settleMobileNativeChatInFlightSend
} from './native-chat/composer/mobile-native-chat-in-flight-sends'
import type { MobileStructuredSends } from './use-mobile-structured-sends'
import { structuredSessionOperationId } from './structured-session-operation-id'
import { isSlashCommandDraft } from '../../../src/shared/native-chat/input/native-chat-slash-commands'
import { UNCONFIRMED_SEND_RESTORED_MESSAGE } from './native-chat/use-mobile-native-chat-unconfirmed-sends'

export function useMobileStructuredNativeChatSendBridge(args: {
  agent: StructuredAgentId | undefined
  sessionCommands?: readonly AgentSessionSlashCommand[]
  sendStructured: (
    text: string,
    images?: string[],
    deadline?: number,
    attachments?: readonly StructuredMobileSendAttachment[],
    skills?: readonly AgentJournalSkillRef[],
    intent?: MobileNativeChatSendIntent
  ) => Promise<MobileNativeChatSendOutcome>
  captureSendOrigin: (text: string) => MobileNativeChatSendOrigin | null
  clearDraftForSend: (origin: MobileNativeChatSendOrigin, text: string) => void
  restoreRejectedDraft: (
    origin: MobileNativeChatSendOrigin,
    text: string,
    options?: { preserveConversationCommands?: boolean }
  ) => void
  holdUnconfirmed: MobileStructuredSends['holdUnconfirmed']
  onSendError: (message: string) => void
}): {
  send: (text: string, images?: string[]) => Promise<boolean>
  sendWithOutcome: (
    text: string,
    images?: string[],
    deadline?: number,
    attachments?: readonly StructuredMobileSendAttachment[],
    sentAt?: number,
    intent?: MobileNativeChatSendIntent
  ) => Promise<MobileNativeChatSendOutcome>
} {
  const {
    agent,
    captureSendOrigin,
    clearDraftForSend,
    holdUnconfirmed,
    onSendError,
    restoreRejectedDraft,
    sendStructured,
    sessionCommands
  } = args
  const sendWithOutcome = useCallback(
    async (
      text: string,
      images?: string[],
      deadline?: number,
      attachments?: readonly StructuredMobileSendAttachment[],
      _sentAt?: number,
      intent?: MobileNativeChatSendIntent
    ): Promise<MobileNativeChatSendOutcome> => {
      const origin = captureSendOrigin(text.trimEnd())
      if (!origin) {
        onSendError('Message not sent (disconnected)')
        return 'rejected'
      }
      // A queued message never sat in the composer, so its send leaves the composer alone.
      const queued = intent?.queued
      const skills = queued ? [...queued.skills] : readMobileNativeChatPickedSkills(origin.draftKey)
      if (!queued) {
        clearDraftForSend(origin, text)
      }
      // Saved, journal id included, in the same write as the clear, so a kill mid-send can be checked against the journal.
      const clientMessageId = structuredSessionOperationId()
      const inFlightId = beginMobileNativeChatInFlightSend(origin, 'structured', text, {
        clientMessageId,
        command: intent?.goal === true || isSlashCommandDraft(text),
        intent
      })
      const created: { clientMessageId?: string } = {}
      const outcome = await sendStructured(text, images, deadline, attachments, skills, {
        ...intent,
        clientMessageId,
        onCreated: (id) => {
          created.clientMessageId = id
          intent?.onCreated?.(id)
        }
      })
      const handBack = () => {
        if (queued) {
          return
        }
        restoreRejectedDraft(origin, text)
        restoreMobileNativeChatPickedSkills(origin.draftDestination, skills)
      }
      if (outcome === 'unknown' && created.clientMessageId) {
        // Uncertain input stays an ordinary bubble until the journal records its id, else it returns to the composer.
        holdUnconfirmed(created.clientMessageId, () => {
          handBack()
          intent?.onHandBack?.()
          onSendError(UNCONFIRMED_SEND_RESTORED_MESSAGE)
          settleMobileNativeChatInFlightSend(inFlightId)
        })
        return outcome
      }
      if (outcome === 'unknown') {
        // A host command whose reply was lost minted no journal id; its text returns now, as a terminal chat's does.
        settleMobileNativeChatInFlightSend(inFlightId)
        restoreRejectedDraft(origin, text, { preserveConversationCommands: true })
        return outcome
      }
      settleMobileNativeChatInFlightSend(inFlightId, outcome === 'rejected' ? 'kept' : 'sent')
      if (outcome === 'rejected') {
        handBack()
      }
      return outcome
    },
    [
      agent,
      captureSendOrigin,
      clearDraftForSend,
      holdUnconfirmed,
      onSendError,
      restoreRejectedDraft,
      sendStructured,
      sessionCommands
    ]
  )
  const send = useCallback(
    async (
      text: string,
      images?: string[],
      deadline?: number,
      attachments?: readonly StructuredMobileSendAttachment[]
    ) => (await sendWithOutcome(text, images, deadline, attachments)) !== 'rejected',
    [sendWithOutcome]
  )
  return { send, sendWithOutcome }
}
