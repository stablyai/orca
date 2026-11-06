import type { MobileSessionController } from './use-mobile-session-controller'

export function runCommandInNewTerminal(
  controller: MobileSessionController,
  command: string
): void {
  void controller.handleCreateTerminal(undefined, {
    startupCommand: command,
    startupCommandDelivery: 'shell-ready',
    terminalView: true
  })
}
