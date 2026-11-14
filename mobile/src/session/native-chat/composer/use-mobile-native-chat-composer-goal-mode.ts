import { createElement, useState, type ReactNode } from 'react'
import { Goal } from 'lucide-react-native'
import type { NativeChatSendFollowUp } from '../../../../../src/shared/native-chat/input/native-chat-follow-up-behavior'
import { isBareStructuredAgentSessionGoalCommand } from '../../../../../src/shared/agent-session/view/structured-agent-session-composer'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import type { MobileStructuredThreadGoal } from '../input/use-mobile-structured-thread-goal'
import type { MobileNativeChatSendIntent } from './mobile-native-chat-send'
import { MobileNativeChatThreadGoalStrip } from '../input/MobileNativeChatThreadGoalStrip'
import { MobileNativeChatComposerModeChip } from './MobileNativeChatComposerModeChip'

type ComposerSend = (text: string, intent?: MobileNativeChatSendIntent) => Promise<boolean>

/** Desktop's goal mode on a structured chat's composer: `/goal` turns the draft into the chat's goal objective. */
export function useMobileNativeChatComposerGoalMode(
  structured: { threadGoal?: MobileStructuredThreadGoal | null; mcpPanel?: unknown } | null,
  editing: boolean,
  sendSurfaceId: string
): {
  /** Picking `/goal` from the menu enters goal mode. */
  menu: { hostSetsGoals: boolean; enter?: () => void } | undefined
  /** A bare /goal enters goal mode and clears the draft; even there it never becomes an objective. */
  consumeBareGoal: (draft: string, clearDraft: () => void) => boolean
  /** Sends the draft; in goal mode as the objective, leaving goal mode once it is set. */
  send: (send: ComposerSend, text: string, intent?: MobileNativeChatSendIntent) => Promise<boolean>
  placeholder: string | undefined
  sendFollowUp: (followUp: NativeChatSendFollowUp | null) => NativeChatSendFollowUp | null
  /** A host goal is no message, so the composer neither queues, steers nor sends a waiting card. */
  holdsFollowUp: boolean
  strip: ReactNode
  chip: ReactNode
} {
  const t = useMobileTranslation()
  const threadGoal = editing ? null : (structured?.threadGoal ?? null)
  const hostSetsGoals = threadGoal?.changes === 'host'
  // Goal mode belongs to the composer surface it was entered on; another chat starts outside it.
  // Each entry is its own object, so a set that lands late never ends a later entry.
  const [entered, setEntered] = useState<{ surface: string } | null>(null)
  const active = structured !== null && !editing && entered?.surface === sendSurfaceId
  const enter = (): void => setEntered({ surface: sendSurfaceId })
  const exit = (): void => setEntered(null)
  return {
    // A queued edit has no goal mode, but still refuses /goal where the host sets goals.
    menu: structured
      ? {
          hostSetsGoals: structured.threadGoal?.changes === 'host',
          ...(editing ? {} : { enter })
        }
      : undefined,
    consumeBareGoal: (draft, clearDraft) => {
      if (!hostSetsGoals || !isBareStructuredAgentSessionGoalCommand(draft)) {
        return false
      }
      clearDraft()
      enter()
      return true
    },
    send: async (send, text, intent) => {
      // `/mcp` opens its sheet as a command, never becoming the objective, and goal mode stays.
      if (!active || (structured?.mcpPanel && /^\/mcp\s*$/i.test(text))) {
        return intent ? send(text, intent) : send(text)
      }
      const sentFrom = entered
      // Keep the caller's choice, such as Steer for an agent-owned /goal sent mid-turn.
      const accepted = await send(text, { ...intent, goal: true })
      if (accepted) {
        setEntered((current) => (current === sentFrom ? null : current))
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
    holdsFollowUp: active && hostSetsGoals,
    // Each goal opens collapsed, so a tap meant for a new goal never lands on the last one's controls.
    strip: threadGoal
      ? createElement(MobileNativeChatThreadGoalStrip, {
          key: `${threadGoal.sessionKey}:${threadGoal.goal?.createdAt ?? ''}`,
          threadGoal
        })
      : null,
    chip: active
      ? createElement(MobileNativeChatComposerModeChip, {
          icon: Goal,
          label: t('chat.goal.chip', 'Goal'),
          exitLabel: t('chat.goal.exitMode', 'Exit goal mode'),
          testID: 'native-chat-goal-chip',
          onExit: exit
        })
      : null
  }
}
