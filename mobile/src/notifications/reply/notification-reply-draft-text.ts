import { appendReturnedDraftText } from '../../../../src/shared/native-chat/input/drafts/returned-draft-text'

/** A retry after a refused save must preserve edits made after the returned paragraph. */
export function appendNotificationReplyDraftText(draft: string, text: string): string {
  const paragraph = text.trimEnd()
  return paragraph && `\n\n${draft.trimEnd()}\n\n`.includes(`\n\n${paragraph}\n\n`)
    ? draft
    : appendReturnedDraftText(draft, text)
}
