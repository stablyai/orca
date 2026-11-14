import { agentImagePasteWrites } from '../../../../../../src/shared/agent-image-paste'
import { agentImagePastePath } from '../../../../../../src/shared/agent-image-paste-path'
import { buildNativeChatImagePasteBytes } from '../../../../../../src/shared/native-chat/input/composer/native-chat-paste-bytes'
import {
  MOBILE_NATIVE_CHAT_MIN_WRITE_TIMEOUT_MS,
  openMobileNativeChatSendBudget,
  readMobileNativeChatInputClear
} from './mobile-native-chat-send'
import { nativeChatTerminalWrite } from '../../../../terminal/session/mobile-session-terminal-operations'
import type { MobileNativeChatRpcSender } from './mobile-native-chat-send'

// Wait for the TUI to register bracketed image attachments before text/Enter arrives.
export const MOBILE_NATIVE_CHAT_IMAGE_SETTLE_MS = 300

type MobileTerminalClient = { id: string; type: 'mobile' }

type PasteImagesArgs = {
  readonly agent?: string | null
  readonly client: MobileNativeChatRpcSender
  readonly terminal: string
  readonly deviceToken: string | null
  readonly imagePaths: readonly string[]
  readonly followedByText: boolean
  // Share the whole action’s budget with following text or the send being healed.
  readonly deadline?: number
  // A seeded launch draft supplies a lower bound for the pre-paste clear.
  readonly seededText?: string
  readonly onWriteStarted?: () => void
}

// Paste paths without Enter and stop on rejection so callers cannot submit partial image input.
export async function pasteMobileNativeChatImagePaths({
  client,
  agent,
  terminal,
  deviceToken,
  imagePaths,
  followedByText,
  deadline: sharedDeadline,
  seededText,
  onWriteStarted
}: PasteImagesArgs): Promise<boolean> {
  const mobileClient: MobileTerminalClient | null = deviceToken
    ? { id: deviceToken, type: 'mobile' }
    : null
  const clientField = mobileClient ? { client: mobileClient } : {}
  // Budget the whole sequence once; independent per-image timeouts would multiply the composer lock.
  const deadline = sharedDeadline ?? openMobileNativeChatSendBudget()
  const inputClear = await readMobileNativeChatInputClear({
    client,
    terminal,
    deadline,
    seededText
  })
  if (inputClear === null) {
    return false
  }
  for (const text of [
    inputClear,
    ...agentImagePasteWrites(
      agent,
      imagePaths.map((path) => buildNativeChatImagePasteBytes(agentImagePastePath(agent, path))),
      followedByText
    )
  ]) {
    const remainingMs = deadline - Date.now()
    // Do not start a write the remaining sequence budget cannot fund.
    if (remainingMs < MOBILE_NATIVE_CHAT_MIN_WRITE_TIMEOUT_MS) {
      return false
    }
    onWriteStarted?.()
    const response = await nativeChatTerminalWrite.request(
      client,
      {
        terminal,
        text,
        enter: false,
        ...clientField
      },
      // Reconnect wait spends the same budget; do not restart its clock after connecting.
      { timeoutMs: remainingMs, budgetSpansConnect: true }
    )
    if (nativeChatTerminalWrite.interpret(response) !== true) {
      return false
    }
  }
  return true
}
