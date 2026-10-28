import { useCallback } from 'react'
import type { StructuredAgentId } from '../../../src/shared/agent-session-provider-handle'
import type { AgentSessionSlashCommand } from '../../../src/shared/agent-session-wire'
import { isStructuredAgentSessionComposerCommand } from '../../../src/shared/structured-agent-session-composer'
import type { MobileNativeChatSendOutcome } from './native-chat/mobile-native-chat-send'
import type { MobileNativeChatSendOrigin } from './native-chat/mobile-native-chat-pending-echo'
import type { StructuredMobileSendAttachment } from './use-mobile-structured-send-with-outcome'
import type { AgentJournalSkillRef } from '../../../src/shared/agent-session-journal-types'
import {
  readMobileNativeChatPickedSkills,
  restoreMobileNativeChatPickedSkills
} from './native-chat/composer/mobile-native-chat-draft-store'

export function useMobileStructuredNativeChatSendBridge(args: {
  agent: StructuredAgentId | undefined
  sessionCommands?: readonly AgentSessionSlashCommand[]
  sendStructured: (
    text: string,
    images?: string[],
    deadline?: number,
    attachments?: readonly StructuredMobileSendAttachment[],
    skills?: readonly AgentJournalSkillRef[]
  ) => Promise<MobileNativeChatSendOutcome>
  captureSendOrigin: (text: string) => MobileNativeChatSendOrigin | null
  clearDraftForSend: (origin: MobileNativeChatSendOrigin, text: string) => void
  restoreRejectedDraft: (origin: MobileNativeChatSendOrigin, text: string) => void
  onSendError: (message: string) => void
}): {
  send: (text: string, images?: string[]) => Promise<boolean>
  sendWithOutcome: (
    text: string,
    images?: string[],
    deadline?: number,
    attachments?: readonly StructuredMobileSendAttachment[]
  ) => Promise<MobileNativeChatSendOutcome>
} {
  const {
    agent,
    captureSendOrigin,
    clearDraftForSend,
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
      attachments?: readonly StructuredMobileSendAttachment[]
    ): Promise<MobileNativeChatSendOutcome> => {
      const origin = captureSendOrigin(text.trimEnd())
      if (!origin) {
        onSendError('Message not sent (disconnected)')
        return 'rejected'
      }
      const isHostCommand = isStructuredAgentSessionComposerCommand(text, agent, sessionCommands)
      const skills = readMobileNativeChatPickedSkills(origin.draftKey)
      clearDraftForSend(origin, text)
      const outcome = await sendStructured(text, images, deadline, attachments, skills)
      // Accepted messages remain host-owned; restore commands whose reply was lost.
      if (outcome === 'rejected' || (outcome === 'unknown' && isHostCommand)) {
        restoreRejectedDraft(origin, text)
        restoreMobileNativeChatPickedSkills(origin.draftKey, skills)
      }
      return outcome
    },
    [
      agent,
      captureSendOrigin,
      clearDraftForSend,
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
