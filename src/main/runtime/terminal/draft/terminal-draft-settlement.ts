import type { TerminalDraftSaveResult } from '../../../../shared/terminal-draft-contract'
import type { PiDraftBridgeResponse } from '../../../pi/draft-bridge-protocol'

/** Maps the agent's answer to a truthful save arm; an unreadable answer is never success. */
export function settleDraftReplace(
  response: PiDraftBridgeResponse | null
): TerminalDraftSaveResult {
  if (!response) {
    return { ok: false, status: 'unknown', reason: 'bridge_timeout' }
  }
  if (response.ok && response.sourceToken) {
    return {
      ok: true,
      status: 'applied',
      sourceToken: response.sourceToken,
      ...(typeof response.text === 'string' ? { text: response.text } : {}),
      ...(response.normalized === true ? { normalized: true } : {})
    }
  }
  if (response.error === 'conflict' && typeof response.text === 'string' && response.sourceToken) {
    return {
      ok: false,
      status: 'conflict',
      conflict: { text: response.text, sourceToken: response.sourceToken }
    }
  }
  if (response.error === 'unavailable') {
    return { ok: false, status: 'unsupported', reason: 'unsupported_agent' }
  }
  return { ok: false, status: 'unknown', reason: 'invalid_bridge_reply' }
}
