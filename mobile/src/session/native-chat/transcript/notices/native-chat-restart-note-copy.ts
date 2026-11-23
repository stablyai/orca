// The host journals restart notes in English, so chats saved earlier and older servers carry the same text.

import {
  AGENT_SESSION_RESTART_CONTINUATION_NOTE as CONTINUED,
  AGENT_SESSION_RESTART_CONTINUATION_REFUSED_NOTE as REFUSED,
  AGENT_SESSION_RESTART_CONTINUATION_UNCONFIRMED_NOTE as UNCONFIRMED,
  AGENT_SESSION_RESTART_NOT_CONNECTED_NOTE as NOT_CONNECTED
} from '../../../../../../src/shared/agent-session/lifecycle/stopping/agent-session-restart-continuation'
import type { Translate } from '../../../../i18n/mobile-i18n'

const WORDS = new Map<string, (t: Translate) => string>([
  [CONTINUED, (t) => t('chat.restartNote.continued', CONTINUED)],
  [REFUSED, (t) => t('chat.restartNote.refused', REFUSED)],
  [UNCONFIRMED, (t) => t('chat.restartNote.unconfirmed', UNCONFIRMED)],
  [NOT_CONNECTED, (t) => t('chat.restartNote.notConnected', NOT_CONNECTED)]
])

/** The restart note in the UI language, or undefined for any other host text. */
export function nativeChatRestartNoteText(text: string, t: Translate): string | undefined {
  return WORDS.get(text)?.(t)
}
