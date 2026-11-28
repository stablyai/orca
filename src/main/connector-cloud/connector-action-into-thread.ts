// Whether a connector action posts into the conversation its chat answers: the chat's own answer,
// as opposed to a post elsewhere, a file staged for a later post or a post scheduled for later.
export function connectorActionIntoThread(action: {
  verb: string
  args: { upload?: unknown; stage?: unknown; postAt?: unknown }
  ref?: string | null | undefined
  conversation: unknown
}): boolean {
  const { verb, args, ref, conversation } = action
  const staging = args.upload !== undefined || args.stage === true
  const scheduled = verb === 'post' && args.postAt !== undefined
  return (
    !staging &&
    !scheduled &&
    (verb === 'reply' ||
      ((verb === 'post' || verb === 'attach') &&
        !ref &&
        conversation !== null &&
        conversation !== undefined))
  )
}
