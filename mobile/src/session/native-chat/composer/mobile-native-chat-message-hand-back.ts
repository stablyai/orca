import type { AgentJournalMessageItem } from '../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import { queuedEditTextForKeptImages } from '../../../../../src/shared/queued-message-edit'
import { appendReturnedDraftText } from '../../../../../src/shared/returned-draft-text'
import { mobileDraftImageOfBlock } from '../input/mobile-queued-message-edit-draft'
import {
  readMobileNativeChatDraftInputs,
  updateMobileNativeChatDraftInputs
} from './mobile-native-chat-draft-inputs'
import { setMobileNativeChatDraftText } from './mobile-native-chat-draft-store'

/** Append a sent message's text and images after what is typed; stable chip ids keep a repeat from doubling them. */
export function returnMobileNativeChatMessageToComposer(
  scopeKey: string,
  /** Unique to this message, so its images never collide with ones already attached. */
  attachmentIdPrefix: string,
  blocks: AgentJournalMessageItem['blocks']
): void {
  const imageIds: string[] = []
  const images = blocks.flatMap((block, index) => {
    if (block.type !== 'image-ref') {
      return []
    }
    const id = `${attachmentIdPrefix}-${index}`
    imageIds.push(id)
    return block.path ? [mobileDraftImageOfBlock(id, block)] : []
  })
  const held = readMobileNativeChatDraftInputs(scopeKey).images
  const added = images.filter((image) => !held.some(({ id }) => id === image.id))
  // `[Image #k]` counts every chip in the composer, so markers move past the images already there.
  const text = queuedEditTextForKeptImages(
    blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n'),
    imageIds,
    [...held, ...added].map(({ id }) => id)
  )
  setMobileNativeChatDraftText(scopeKey, (draft) => appendReturnedDraftText(draft, text))
  if (added.length > 0) {
    updateMobileNativeChatDraftInputs(scopeKey, (current) => ({
      ...current,
      images: [...current.images, ...added]
    }))
  }
}
