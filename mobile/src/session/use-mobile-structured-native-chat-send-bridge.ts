import type { SessionOptionDescriptor } from '../../../src/shared/native-chat/input/native-chat-session-options'
import { isStructuredAgentSessionComposerCommand } from '../../../src/shared/agent-session/view/structured-agent-session-composer'
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
import type { MobileStructuredSends } from './use-mobile-structured-sends'
import { UNCONFIRMED_SEND_RESTORED_MESSAGE } from './native-chat/use-mobile-native-chat-unconfirmed-sends'

const EMPTY_OPTIONS: readonly SessionOptionDescriptor[] = []

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
  isModelWritePending?: () => boolean
  optionSnapshot?: readonly SessionOptionDescriptor[]
  captureSendOrigin: (text: string) => MobileNativeChatSendOrigin | null
  clearDraftForSend: (origin: MobileNativeChatSendOrigin, text: string) => void
  restoreRejectedDraft: (origin: MobileNativeChatSendOrigin, text: string) => void
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
    isModelWritePending,
    optionSnapshot = EMPTY_OPTIONS,
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
      const isHostCommand = isStructuredAgentSessionComposerCommand(text, agent, optionSnapshot)
      if (!isHostCommand && isModelWritePending?.()) {
        onSendError('Message not sent (model selection is still updating)')
        return 'rejected'
      }
      const origin = captureSendOrigin(text.trimEnd())
      if (!origin) {
        onSendError('Message not sent (disconnected)')
        return 'rejected'
      }
      const skills = readMobileNativeChatPickedSkills(origin.draftKey)
      clearDraftForSend(origin, text)
      const created: { clientMessageId?: string } = {}
      const outcome = await sendStructured(text, images, deadline, attachments, skills, {
        ...intent,
        onCreated: (id) => {
          created.clientMessageId = id
          intent?.onCreated?.(id)
        }
      })
      const handBack = () => {
        restoreRejectedDraft(origin, text)
        restoreMobileNativeChatPickedSkills(origin.draftDestination, skills)
      }
      if (outcome === 'rejected') {
        handBack()
      } else if (outcome === 'unknown' && created.clientMessageId) {
        // Uncertain input stays an ordinary bubble until the journal records its id, else it returns to the composer.
        holdUnconfirmed(created.clientMessageId, () => {
          handBack()
          intent?.onHandBack?.()
          onSendError(UNCONFIRMED_SEND_RESTORED_MESSAGE)
        })
      }
      return outcome
    },
    [
      agent,
      captureSendOrigin,
      clearDraftForSend,
      holdUnconfirmed,
      isModelWritePending,
      optionSnapshot,
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
