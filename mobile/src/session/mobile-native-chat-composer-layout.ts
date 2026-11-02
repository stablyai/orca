import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

/** The pickers row only shows while the user is writing; a typed draft, a picked image or an open
 *  picker drawer keeps it, so collapsing never hides what they were editing. */
export function mobileNativeChatComposerExpanded(input: {
  focused: boolean
  pickerOpen: boolean
  draft: string
  attachmentCount: number
}): boolean {
  return input.focused || input.pickerOpen || input.draft.length > 0 || input.attachmentCount > 0
}

/** Keep Send for an active upload/dictation edit; otherwise offer the action available now. */
export function mobileNativeChatComposerShowsStop(input: {
  canStop: boolean
  sendBlocked: boolean
  canSend: boolean
  editing: boolean
  draft: string
  attachmentCount: number
}): boolean {
  const nothingTyped = input.draft.trim().length === 0 && input.attachmentCount === 0
  return input.canStop && (input.sendBlocked || nothingTyped || (!input.editing && !input.canSend))
}

/** Tool calls in the loaded transcript; the Tools toggle is offered only when there are some. */
export function mobileNativeChatToolCallCount(messages: readonly NativeChatMessage[]): number {
  let count = 0
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool-call') {
        count += 1
      }
    }
  }
  return count
}
