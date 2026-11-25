/** Keep Send for an active upload/dictation edit and while its own send is out; otherwise offer the action available now. */
export function mobileNativeChatComposerShowsStop(input: {
  canStop: boolean
  sendBlocked: boolean
  canSend: boolean
  /** This composer's send is on its way: Send shows it, even though the draft already cleared. */
  sending: boolean
  editing: boolean
  draft: string
  attachmentCount: number
}): boolean {
  const nothingTyped = input.draft.trim().length === 0 && input.attachmentCount === 0
  return (
    input.canStop &&
    !input.sending &&
    (input.sendBlocked || nothingTyped || (!input.editing && !input.canSend))
  )
}
