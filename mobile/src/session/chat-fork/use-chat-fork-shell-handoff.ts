import { useCallback, type RefObject } from 'react'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import type { ExecutionHostId } from '../../../../src/shared/execution-host/execution-host'
import type { NativeChatMessage } from '../../../../src/shared/native-chat/native-chat-types'
import type { MobileNativeChatFork } from '../native-chat/history/use-mobile-native-chat-fork'
import type { MobileSessionController } from '../use-mobile-session-controller'
import { chatForkCopy } from './chat-fork-copy'
import type { ChatForkPreset } from './chat-fork-selection'
import { chatForkRecapOf, chatForkSheetSource } from './chat-fork-sheet-source'
import {
  chatForkShellParams,
  settleShellAnswer,
  type ChatForkRunHere
} from './chat-fork-shell-answer'
import { useShellChatForkHandoff } from './shell-chat-fork-handoff'

/** In the served page, opens the app's Fork sheet instead of the page's; null where the page's own
 *  sheet serves (the app itself, or a shell without the verb). */
export function useChatForkShellHandoff(input: {
  fork: MobileNativeChatFork
  latestController: RefObject<MobileSessionController>
  executionHost: ExecutionHostId | undefined
  runHere: ChatForkRunHere
}): ((message: NativeChatMessage, preset: ChatForkPreset) => void) | null {
  const call = useShellChatForkHandoff()
  const { fork, latestController, executionHost, runHere } = input
  const handOff = useCallback(
    (message: NativeChatMessage, preset: ChatForkPreset) => {
      const current = latestController.current
      const source = call ? chatForkSheetSource(current, fork, executionHost) : null
      if (!call || !source) {
        return
      }
      const recap = chatForkRecapOf(current, source.agent)
      // The shell's sheet picks copy or recap; a copy's own gate is checked once it comes back.
      const started = fork.forkWith(
        message,
        async (_agent, forkFrom) => {
          try {
            const answer = await call(chatForkShellParams(source, preset, forkFrom, recap))
            await settleShellAnswer(answer, source, forkFrom, {
              copyOffered: fork.copyOffered,
              runHere,
              showToast: current.showToast
            })
          } catch (error) {
            const detail = error instanceof Error ? error.message.trim() : ''
            current.showToast(
              chatForkCopy.failed(TUI_AGENT_DISPLAY_NAMES[source.agent], detail),
              4000
            )
          }
        },
        'recap'
      )
      if (!started) {
        current.showToast(chatForkCopy.notNow(), 3000)
      }
    },
    [call, executionHost, fork, latestController, runHere]
  )
  return call ? handOff : null
}
