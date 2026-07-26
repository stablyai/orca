import type { RpcClient } from '../transport/rpc-client'
import { buildMobileImagePastePayload } from './mobile-clipboard-image'
import { isTerminalSendRpcAccepted } from '../terminal/terminal-send-rpc-response'

// Give the agent TUI a beat to register each bracketed image paste before the
// message text + Enter arrive, so the image attaches instead of being treated as
// part of the prompt body (mirrors desktop's NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS).
export const MOBILE_NATIVE_CHAT_IMAGE_SETTLE_MS = 300

// Ctrl+U kills the agent's unsubmitted input line. Sent before pasting so a retry
// after a rejected body/Enter can't leave a stale image paste that then rides along
// with (and duplicates) the next attempt — matches desktop clearUnsubmittedAgentInput.
const MOBILE_NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT = '\x15'

type MobileTerminalClient = { id: string; type: 'mobile' }

type PasteImagesArgs = {
  readonly client: Pick<RpcClient, 'sendRequest'>
  readonly terminal: string
  readonly deviceToken: string | null
  readonly imagePaths: readonly string[]
}

/** Clears the agent's unsubmitted input line, then pastes each uploaded image
 *  path into the terminal as a bracketed paste (no Enter) — the same payload
 *  desktop native chat rides along on submit. The leading clear keeps a retry
 *  idempotent after a failed body/Enter. Returns false as soon as the host rejects
 *  one, so the caller can abort before Enter. */
export async function pasteMobileNativeChatImagePaths({
  client,
  terminal,
  deviceToken,
  imagePaths
}: PasteImagesArgs): Promise<boolean> {
  const mobileClient: MobileTerminalClient | null = deviceToken
    ? { id: deviceToken, type: 'mobile' }
    : null
  const clientField = mobileClient ? { client: mobileClient } : {}
  for (const text of [
    MOBILE_NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
    ...imagePaths.map(buildMobileImagePastePayload)
  ]) {
    const response = await client.sendRequest('terminal.send', {
      terminal,
      text,
      enter: false,
      ...clientField
    })
    if (!isTerminalSendRpcAccepted(response)) {
      return false
    }
  }
  return true
}
