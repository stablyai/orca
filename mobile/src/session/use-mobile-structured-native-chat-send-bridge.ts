import { formatAgentTypeLabel } from '../../../src/shared/agent-type-label'
import { MAX_SKILL_REFS } from '../../../src/shared/rpc-contract/structured-agent-session-message-params'
import {
  composerSkillOccurrences,
  SkillRefLimitError,
  structuredAgentSessionSendBody
} from '../../../src/shared/structured-agent-session-send-mutation'
import type { AgentJournalSkillRef } from '../../../src/shared/agent-session-journal-types'
import { useCallback } from 'react'
import type { StructuredAgentId } from '../../../src/shared/agent-session-provider-handle'
import { isStructuredAgentSessionComposerCommand } from '../../../src/shared/structured-agent-session-composer'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import type { MobileNativeChatSendOrigin } from './use-mobile-native-chat-drafts'
import type { StructuredMobileSendAttachment } from './use-mobile-structured-send-with-outcome'

export function useMobileStructuredNativeChatSendBridge(args: {
  agent: StructuredAgentId | undefined
  sendStructured: (
    text: string,
    images?: string[],
    deadline?: number,
    attachments?: readonly StructuredMobileSendAttachment[],
    skills?: readonly AgentJournalSkillRef[]
  ) => Promise<MobileNativeChatSendOutcome>
  authoringReady?: boolean
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
    authoringReady = true,
    onSendError,
    restoreRejectedDraft,
    sendStructured
  } = args
  const sendWithOutcome = useCallback(
    async (
      text: string,
      images?: string[],
      deadline?: number,
      attachments?: readonly StructuredMobileSendAttachment[]
    ): Promise<MobileNativeChatSendOutcome> => {
      if (!authoringReady) {
        return 'rejected'
      }
      const origin = captureSendOrigin(text.trimEnd())
      if (!origin) {
        onSendError('Message not sent (disconnected)')
        return 'rejected'
      }
      const isHostCommand = isStructuredAgentSessionComposerCommand(text, agent)
      const skills = origin.skills
      try {
        if (skills?.length) {
          structuredAgentSessionSendBody(
            text,
            [],
            composerSkillOccurrences(text, skills).map(({ ref }) => ref)
          )
        }
      } catch (error) {
        if (!(error instanceof SkillRefLimitError)) {
          throw error
        }
        onSendError(
          `Your message was not sent to ${formatAgentTypeLabel(agent)}. Keep at most ${MAX_SKILL_REFS} selected skill files and try again.`
        )
        return 'rejected'
      }
      clearDraftForSend(origin, text)
      const outcome = skills?.length
        ? await sendStructured(text, images, deadline, attachments, skills)
        : attachments !== undefined
          ? await sendStructured(text, images, deadline, attachments)
          : deadline !== undefined
            ? await sendStructured(text, images, deadline)
            : images !== undefined
              ? await sendStructured(text, images)
              : await sendStructured(text)
      // The structured session draws or holds a message the host took; a command's lost answer
      // comes back instead.
      if (outcome === 'rejected' || (outcome === 'unknown' && isHostCommand)) {
        restoreRejectedDraft(origin, text)
      }
      return outcome
    },
    [
      agent,
      authoringReady,
      captureSendOrigin,
      clearDraftForSend,
      onSendError,
      restoreRejectedDraft,
      sendStructured
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
