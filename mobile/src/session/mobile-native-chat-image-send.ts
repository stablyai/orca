import type { RpcClient } from '../transport/rpc-client'
import { getNativeChatAttachmentForm } from '../../../src/shared/native-chat-agent-profiles'
import { buildNativeChatAttachmentWrites } from '../../../src/shared/native-chat-paste-bytes'
import {
  MOBILE_NATIVE_CHAT_MIN_WRITE_TIMEOUT_MS,
  openMobileNativeChatSendBudget
} from './mobile-native-chat-send'
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
  /** Picks the attachment form: only agents with a verified image-paste gesture
   *  get a bracketed raw path, the rest get `@path` (getNativeChatAttachmentForm). */
  readonly agent: string | null | undefined
  readonly followedByText: boolean
  /** Budget shared with the rest of the user action (the text body that follows, or
   *  the send this is healing for). Omit to open a fresh one for this paste alone. */
  readonly deadline?: number
  /** Bytes for the leading clear. Defaults to a single Ctrl+U, which clears only
   *  ONE logical line — callers holding a parked multi-line launch draft must
   *  pass a burst, or its earlier lines survive and glue onto the message. */
  readonly clearInput?: string
}

/** Clears the agent's unsubmitted input line, then writes each uploaded image
 *  path into the terminal in the form `agent` understands (no Enter) — the same
 *  payloads desktop native chat rides along on submit. The leading clear keeps a retry
 *  idempotent after a failed body/Enter. Returns false as soon as the host rejects
 *  one, so the caller can abort before Enter. */
export async function pasteMobileNativeChatImagePaths({
  client,
  terminal,
  deviceToken,
  imagePaths,
  agent,
  followedByText,
  deadline: sharedDeadline,
  clearInput
}: PasteImagesArgs): Promise<boolean> {
  const mobileClient: MobileTerminalClient | null = deviceToken
    ? { id: deviceToken, type: 'mobile' }
    : null
  const clientField = mobileClient ? { client: mobileClient } : {}
  // Why: this is a sequential loop, so a per-write budget multiplies by the number
  // of images — the composer stays `sending` the whole time. Budget the sequence
  // once and let each write draw from what's left.
  const deadline = sharedDeadline ?? openMobileNativeChatSendBudget()
  for (const text of [
    clearInput ?? MOBILE_NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
    ...buildNativeChatAttachmentWrites(
      imagePaths,
      getNativeChatAttachmentForm(agent),
      followedByText
    )
  ]) {
    const remainingMs = deadline - Date.now()
    // Why: the budget is the whole sequence's — starting a write it can't fund would
    // let a multi-image paste overrun before the text body even begins its own send.
    // Abort instead; the caller reports the failure and can retry.
    if (remainingMs < MOBILE_NATIVE_CHAT_MIN_WRITE_TIMEOUT_MS) {
      return false
    }
    const response = await client.sendRequest(
      'terminal.send',
      {
        terminal,
        text,
        enter: false,
        ...clientField
      },
      // The remaining budget covers the reconnect wait too; a fresh post-connect
      // clock here would let one write outlast the whole sequence's ceiling.
      { timeoutMs: remainingMs, budgetSpansConnect: true }
    )
    if (!isTerminalSendRpcAccepted(response)) {
      return false
    }
  }
  return true
}
