import type { RefObject } from 'react'
import type { TextInputInstance } from 'react-native'
import type { SlashCommandSuggestion } from '../../../../../../src/shared/native-chat/input/commands/native-chat-slash-commands'
import type { NativeChatContextUsageSummary } from '../../../../../../src/shared/native-chat/native-chat-context-usage-summary'
import type { MobileNativeChatSessionOptionsController } from '../../input/session-options/use-mobile-native-chat-session-options'
import type { MobileNativeChatContext } from './MobileNativeChatContextUsage'
import type { MobileNativeChatSendIntent } from '../delivery/mobile-native-chat-send'
import { createNonSecureContextUuid } from '../../../../../../src/shared/identifiers/non-secure-context-uuid'

/** What the + sheet offers while plan or goal mode is off, and the context line's /compact where the chat has it. */
export function mobileNativeChatComposerModes(args: {
  options: MobileNativeChatSessionOptionsController | undefined
  structured: boolean
  editing: boolean
  offline: boolean
  /** The goal mode hook's menu; `enter` is absent in a queued edit. */
  goalMenu: { hostSetsGoals: boolean; enter?: () => void } | undefined
  goalActive: boolean
  commands: readonly SlashCommandSuggestion[]
  contextUsage: NativeChatContextUsageSummary | null
  onSend: (text: string, intent?: MobileNativeChatSendIntent) => Promise<boolean>
  fieldRef: RefObject<TextInputInstance | null>
}): { onPlan?: () => void; onGoal?: () => void; context: MobileNativeChatContext } {
  const { options, goalMenu, fieldRef } = args
  const mode = options?.snapshot.find((entry) => entry.id === 'interactionMode')
  const offersPlan =
    !args.editing &&
    options !== undefined &&
    mode?.kind.type === 'select' &&
    mode.settable &&
    mode.kind.currentValue !== 'plan' &&
    options.optionSurface?.admits?.('interactionMode', 'plan') === true
  // As picking /goal would: the agent's own /goal only where the host sets goals.
  const goalCommand = args.commands.find((command) => command.name === 'goal')
  const enterGoal =
    !args.goalActive &&
    goalMenu?.enter &&
    goalCommand &&
    (goalMenu.hostSetsGoals || goalCommand.builtin === true)
      ? goalMenu.enter
      : undefined
  // Context is read only from a structured chat, whose host runs /compact as a command.
  const compacts =
    args.structured &&
    !args.editing &&
    !args.offline &&
    options?.conversationCommands?.includes('compact') === true
  return {
    ...(offersPlan
      ? {
          onPlan: () => {
            void options.setOption('interactionMode', 'plan')
            fieldRef.current?.focus()
          }
        }
      : {}),
    ...(enterGoal
      ? {
          onGoal: () => {
            enterGoal()
            fieldRef.current?.focus()
          }
        }
      : {}),
    context: {
      usage: args.contextUsage,
      ...(compacts
        ? {
            // Sent as a queued message is: its own text and no chips, never cleared from or returned to the draft.
            onCompact: () =>
              void args.onSend('/compact', {
                queued: {
                  id: createNonSecureContextUuid(),
                  images: [],
                  files: [],
                  skills: [],
                  skillOrigin: null
                }
              })
          }
        : {})
    }
  }
}
