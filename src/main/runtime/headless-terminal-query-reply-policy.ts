import type { TuiAgent } from '../../shared/tui-agent'

/* oxlint-disable no-control-regex -- query replies are ESC/DCS control sequences by definition */
const XTVERSION_REPLY = new RegExp('^\u001bP>\\|[^\u001b]*\u001b\\\\$')
const OSC_COLOR_QUERY_REPLY = new RegExp('^\u001b\\](?:4;|10;|11;|12;)')
/* oxlint-enable no-control-regex */

export function shouldForwardHeadlessTerminalQueryReply(
  launchAgent: TuiAgent | null | undefined,
  reply: string
): boolean {
  if (launchAgent === 'grok') {
    return !XTVERSION_REPLY.test(reply)
  }
  // jcode renders early OSC color replies as input (#12112); match renderer/startup suppression.
  if (launchAgent === 'jcode') {
    return !OSC_COLOR_QUERY_REPLY.test(reply)
  }
  return true
}
