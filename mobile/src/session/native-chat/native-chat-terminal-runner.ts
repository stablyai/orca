import type { MobileSessionController } from '../use-mobile-session-controller'

/** A chat's "Run in terminal": a new terminal runs the command once its shell is ready. */
export function nativeChatTerminalRunner(
  controller: Pick<MobileSessionController, 'handleCreateTerminal'>
): (command: string) => void {
  return (command) =>
    void controller.handleCreateTerminal(undefined, {
      startupCommand: command,
      startupCommandDelivery: 'shell-ready',
      terminalView: true
    })
}
