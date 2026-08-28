import type { TuiAgent } from '../../shared/tui-agent'

/* oxlint-disable no-control-regex -- XTVERSION replies are DCS control sequences. */
const XTVERSION_REPLY = new RegExp('^\u001bP>\\|[^\u001b]*\u001b\\\\$')
/* oxlint-enable no-control-regex */

export function shouldForwardHeadlessTerminalQueryReply(
  launchAgent: TuiAgent | null | undefined,
  reply: string
): boolean {
  return launchAgent !== 'grok' || !XTVERSION_REPLY.test(reply)
}
