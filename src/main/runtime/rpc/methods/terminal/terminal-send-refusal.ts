import type { RuntimeTerminalSend } from '../../../../../shared/runtime-terminal-send-contract'

export function refusedSend(
  handle: string,
  refusedReason?: RuntimeTerminalSend['refusedReason'],
  inputGeneration?: number
): { send: RuntimeTerminalSend } {
  return {
    send: {
      handle,
      accepted: false,
      bytesWritten: 0,
      ...(refusedReason ? { refusedReason } : {}),
      ...(inputGeneration === undefined ? {} : { inputGeneration })
    }
  }
}
