// Whether a connector action posts into the conversation its chat answers: the chat's own answer,
// as opposed to a post elsewhere or a file staged for a later post.
export function connectorActionIntoThread(action: {
  verb: string
  args: { upload?: unknown; stage?: unknown }
  ref?: string | null | undefined
  conversation: unknown
}): boolean {
  const { verb, args, ref, conversation } = action
  const staging = args.upload !== undefined || args.stage === true
  return (
    !staging &&
    (verb === 'reply' ||
      ((verb === 'post' || verb === 'attach') &&
        !ref &&
        conversation !== null &&
        conversation !== undefined))
  )
}
