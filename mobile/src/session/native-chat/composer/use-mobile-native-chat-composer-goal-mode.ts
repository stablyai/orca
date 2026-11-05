import { createElement, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { NativeChatSendFollowUp } from '../../../../../src/shared/native-chat/input/native-chat-follow-up-behavior'
import { isBareStructuredAgentSessionGoalCommand } from '../../../../../src/shared/agent-session/view/structured-agent-session-composer'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import type { MobileStructuredThreadGoal } from '../../use-mobile-structured-thread-goal'
import type { MobileNativeChatSendIntent } from '../mobile-native-chat-send'
import { MobileNativeChatThreadGoalStrip } from '../input/MobileNativeChatThreadGoalStrip'
import { MobileNativeChatComposerGoalChip } from './MobileNativeChatComposerGoalChip'

type ComposerSend = (text: string, intent?: MobileNativeChatSendIntent) => Promise<boolean>

/** Desktop's goal mode on a structured chat's composer: `/goal` turns the draft into the chat's goal objective. */
export function useMobileNativeChatComposerGoalMode(
  structured: { threadGoal?: MobileStructuredThreadGoal | null } | null,
  editing: boolean,
  sendSurfaceId: string
): {
  /** Picking `/goal` from the menu enters goal mode. */
  menu: { hostSetsGoals: boolean; enter: () => void } | undefined
  /** A bare /goal enters goal mode and clears the draft; even there it never becomes an objective. */
  consumeBareGoal: (draft: string, clearDraft: () => void) => boolean
  /** Sends the draft; in goal mode as the objective, leaving goal mode once it is set. */
  send: (send: ComposerSend, text: string, intent?: MobileNativeChatSendIntent) => Promise<boolean>
  placeholder: string | undefined
  sendFollowUp: (followUp: NativeChatSendFollowUp | null) => NativeChatSendFollowUp | null
  strip: ReactNode
  chip: ReactNode
} {
  const t = useMobileTranslation()
  const threadGoal = editing ? null : (structured?.threadGoal ?? null)
  const hostSetsGoals = threadGoal?.changes === 'host'
  // Goal mode belongs to the composer surface it was entered on; another chat starts outside it.
  const [enteredOn, setEnteredOn] = useState<string | null>(null)
  const active = structured !== null && !editing && enteredOn === sendSurfaceId
  const surfaceRef = useRef(sendSurfaceId)
  useLayoutEffect(() => {
    surfaceRef.current = sendSurfaceId
  }, [sendSurfaceId])
  const enter = (): void => setEnteredOn(sendSurfaceId)
  const exit = (): void => setEnteredOn(null)
  return {
    menu: structured && !editing ? { hostSetsGoals, enter } : undefined,
    consumeBareGoal: (draft, clearDraft) => {
      if (!hostSetsGoals || !isBareStructuredAgentSessionGoalCommand(draft)) {
        return false
      }
      clearDraft()
      enter()
      return true
    },
    send: async (send, text, intent) => {
      if (!active) {
        return intent ? send(text, intent) : send(text)
      }
      const surface = sendSurfaceId
      const accepted = await send(text, { goal: true })
      if (accepted && surfaceRef.current === surface) {
        exit()
      }
      return accepted
    },
    placeholder: active
      ? t(
          'chat.goal.placeholder',
          'Describe your goal, define measurable outcomes for best results'
        )
      : undefined,
    // A host goal is no message, so it neither queues nor steers.
    sendFollowUp: (followUp) => (active && hostSetsGoals ? null : followUp),
    strip: threadGoal
      ? createElement(MobileNativeChatThreadGoalStrip, { key: threadGoal.sessionKey, threadGoal })
      : null,
    chip: active ? createElement(MobileNativeChatComposerGoalChip, { onExit: exit }) : null
  }
}
