/** IPC args are untrusted. A bad child id must not fall through to the parent transcript. */
export function nativeChatReadSessionBounds(args: {
  beforeOffset?: unknown
  subagentId?: unknown
}): { beforeOffset?: number; subagentId?: string } | { error: string } {
  if (
    args.beforeOffset !== undefined &&
    (typeof args.beforeOffset !== 'number' ||
      !Number.isInteger(args.beforeOffset) ||
      args.beforeOffset < 0)
  ) {
    return { error: 'Transcript unavailable' }
  }
  if (
    args.subagentId !== undefined &&
    (typeof args.subagentId !== 'string' ||
      args.subagentId.length < 1 ||
      args.subagentId.length > 512)
  ) {
    return { error: 'Transcript unavailable' }
  }
  return {
    ...(typeof args.beforeOffset === 'number' ? { beforeOffset: args.beforeOffset } : {}),
    ...(typeof args.subagentId === 'string' ? { subagentId: args.subagentId } : {})
  }
}
