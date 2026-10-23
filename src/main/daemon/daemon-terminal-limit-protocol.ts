import {
  isConfiguredTerminalLimit,
  type TerminalLimitStatus
} from '../../shared/terminal-limit-policy'
import type { HostTerminalPolicy } from './host-terminal-policy'

/** New requests remain unknown on older daemons; no protocol-generation change or replacement. */
export function answerTerminalLimitRequest(
  request: { type: string; payload?: unknown },
  policy: HostTerminalPolicy,
  nonce: string,
  isCurrent: () => boolean
): Promise<TerminalLimitStatus> | undefined {
  if (request.type !== 'terminalLimitStatus' && request.type !== 'setTerminalLimit') {
    return undefined
  }
  const deadline = Date.now() + 2_000
  const work = async (): Promise<TerminalLimitStatus> => {
    if (!isCurrent()) {
      throw new Error('Terminal host changed. Refresh the setting and try again.')
    }
    if (request.type === 'setTerminalLimit') {
      const update = request.payload
      if (
        typeof update !== 'object' ||
        update === null ||
        !('maxTerminals' in update) ||
        !isConfiguredTerminalLimit(update.maxTerminals) ||
        !('daemonNonce' in update) ||
        update.daemonNonce !== nonce
      ) {
        throw new Error('Terminal setting changed. Refresh the setting and try again.')
      }
      return policy.save(update.maxTerminals, isCurrent, nonce, deadline)
    }
    return policy.status(nonce, isCurrent, deadline)
  }
  return work()
}
