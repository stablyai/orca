import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { editMobileNativeChatDraft } from '../session/native-chat/composer/mobile-native-chat-draft-store'
import { terminalInputSend } from '../terminal/host-operations/mobile-terminal-operations'
import {
  buildTerminalSendParams,
  TERMINAL_INPUT_SEND_OPTIONS
} from '../terminal/input-delivery/terminal-send-request'
import { insertDictationText } from './mobile-dictation-text-insertion'

// Where a dictation's words go when its screen is gone or behind another: the chat's draft, or the terminal's input.
export type MobileDictationAwayTarget =
  | { readonly field: 'chat'; readonly scope: string }
  | { readonly field: 'live'; readonly handle: string }
  | null

// The draft keeps the words (never sent); a terminal gets them typed in, never Enter. False when they did not land.
export async function insertMobileDictationAway(
  owner: {
    readonly client: RpcClient | null
    readonly target: MobileDictationAwayTarget
  },
  text: string
): Promise<boolean> {
  const { target } = owner
  if (target?.field === 'chat') {
    editMobileNativeChatDraft(
      target.scope,
      (current) => insertDictationText(current, text, null).text
    )
    return true
  }
  if (target?.field !== 'live' || !owner.client) {
    return false
  }
  try {
    const reply = await terminalInputSend.request(
      owner.client,
      buildTerminalSendParams({
        terminal: target.handle,
        text,
        enter: false,
        // No phone identity: a phone may only claim a terminal it is watching, and this one is off screen; the words go in as plain typed input.
        deviceToken: null
      }),
      TERMINAL_INPUT_SEND_OPTIONS
    )
    return terminalInputSend.interpret(reply) === true
  } catch {
    return false
  }
}
