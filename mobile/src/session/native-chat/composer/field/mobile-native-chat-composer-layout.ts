/** An empty composer keeps Stop reachable while its send is out. */
export function mobileNativeChatComposerShowsStop(input: {
  canStop: boolean
  sendBlocked: boolean
  canSend: boolean
  /** This composer's send is on its way. */
  sending: boolean
  editing: boolean
  draft: string
  attachmentCount: number
}): boolean {
  const nothingTyped = input.draft.trim().length === 0 && input.attachmentCount === 0
  return (
    input.canStop &&
    (nothingTyped || (!input.sending && (input.sendBlocked || (!input.editing && !input.canSend))))
  )
}
