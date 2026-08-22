import type {
  TerminalWindowContext,
  TerminalWindowTransferAck,
  TerminalWindowTransferCommand,
  TerminalWindowTransferResult,
  TerminalWindowTransferSeed
} from '../../shared/terminal-window-transfer'

export type TerminalWindowApi = {
  detach: (seed: TerminalWindowTransferSeed) => Promise<TerminalWindowTransferResult>
  ack: (ack: TerminalWindowTransferAck) => void
  onCommand: (callback: (command: TerminalWindowTransferCommand) => void) => () => void
  getContext: () => Promise<TerminalWindowContext>
}
