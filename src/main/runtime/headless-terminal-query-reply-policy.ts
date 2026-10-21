import type { TuiAgent } from '../../shared/tui-agent'

/* oxlint-disable no-control-regex -- query replies are ESC/DCS control sequences by definition */
const XTVERSION_REPLY = new RegExp('^\u001bP>\\|[^\u001b]*\u001b\\\\$')
// Why: OSC 4/10/11/12 are the view-attribute color replies (terminal-view-attribute-responder.ts).
const OSC_COLOR_QUERY_REPLY = new RegExp('^\u001b\\](?:4;|10;|11;|12;)')
/* oxlint-enable no-control-regex */

export function shouldForwardHeadlessTerminalQueryReply(
  launchAgent: TuiAgent | null | undefined,
  reply: string
): boolean {
  if (launchAgent === 'grok') {
    return !XTVERSION_REPLY.test(reply)
  }
  // Why: jcode themes itself and renders the cooked OSC color reply as composer
  // text when its input loop is not ready (same leak class as #12112); the
  // renderer and the startup ingress skip jcode too, so keep the headless
  // emulator consistent.
  if (launchAgent === 'jcode') {
    return !OSC_COLOR_QUERY_REPLY.test(reply)
  }
  return true
}
