// A request this build cannot place: its own words and one line, never an option to approve.
// Same line as desktop (mobile renders plain strings; there is no catalog).

import type { MobileChatPermission } from './mobile-native-chat-permission'

export const MOBILE_UNSUPPORTED_DECISION_LINE = 'This request needs a newer version of Orca.'

export function projectUnsupportedDecision(text: string | undefined): MobileChatPermission {
  return text
    ? { title: text, description: MOBILE_UNSUPPORTED_DECISION_LINE, options: [] }
    : { title: MOBILE_UNSUPPORTED_DECISION_LINE, options: [] }
}

/** A structured prompt with an unknown subject: unsupported, but still cancellable by identity. */
export function projectUnsupportedStructuredPrompt(
  item: { itemId: string; revision: number },
  text: string | undefined
): MobileChatPermission {
  return {
    ...projectUnsupportedDecision(text),
    prompt: { itemId: item.itemId, expectedRevision: item.revision }
  }
}
