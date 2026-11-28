import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'

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
  // jcode and agy paint an early OSC 10/11 reply as composer text (#12112, #51192).
  if (launchAgent === 'jcode' || launchAgent === 'antigravity') {
    return !OSC_COLOR_QUERY_REPLY.test(reply)
  }
  return true
}
