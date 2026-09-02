import { isTerminalQueryReply } from '../../../src/shared/terminal-query-reply'

export function routeTerminalQueryReply(
  message: Record<string, unknown>,
  onTerminalQueryReply: ((bytes: string) => void) | undefined
): void {
  if (
    message.type === 'terminal-data' &&
    typeof message.bytes === 'string' &&
    isTerminalQueryReply(message.bytes)
  ) {
    onTerminalQueryReply?.(message.bytes)
  }
}
