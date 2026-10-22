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
