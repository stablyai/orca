import type { NativeChatSignInRequest } from '../../../../src/shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import type { MobileSessionController } from '../use-mobile-session-controller'

export type NativeChatTerminalRunner = (command: string, signIn: NativeChatSignInRequest) => void

/** A chat's "Run in terminal": a new terminal runs the command once its shell is ready. */
export function nativeChatTerminalRunner(
  controller: Pick<
    MobileSessionController,
    'worktreeId' | 'worktreeHostId' | 'handleCreateTerminal'
  >
): NativeChatTerminalRunner {
  return (command, nativeChatSignIn) => {
    void controller.handleCreateTerminal(undefined, {
      startupCommand: command,
      nativeChatSignIn,
      startupCommandDelivery: 'shell-ready',
      terminalView: true
    })
  }
}
