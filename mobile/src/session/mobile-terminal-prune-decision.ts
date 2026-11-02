// Retain chat-covered input leases through graph reload omissions; stream end/error detects dead PTYs, and list reappearance refills bounded rearms.
export function shouldPruneTerminalHandle(args: {
  handle: string
  liveHandles: ReadonlySet<string>
  showNativeChat: boolean
  activeHandle: string | null
}): boolean {
  if (args.liveHandles.has(args.handle)) {
    return false
  }
  return !(args.showNativeChat && args.handle === args.activeHandle)
}

export function createTerminalPrunePredicate(context: {
  liveHandles: ReadonlySet<string>
  showNativeChat: boolean
  activeHandle: string | null
}): (handle: string) => boolean {
  return (handle) => shouldPruneTerminalHandle({ handle, ...context })
}

// Sweep preferences against the same retained handle set as subscriptions so chat’s live-input opt-out survives omissions.
export function resolveRetainedTerminalHandles(context: {
  liveHandles: ReadonlySet<string>
  showNativeChat: boolean
  activeHandle: string | null
}): ReadonlySet<string> {
  const { activeHandle } = context
  if (!activeHandle || shouldPruneTerminalHandle({ handle: activeHandle, ...context })) {
    return context.liveHandles
  }
  return new Set(context.liveHandles).add(activeHandle)
}

// Cached handles may outlive subscriptions; preserve map identity when nothing is retired.
export function pruneTerminalHandleMap<T>(
  previous: Map<string, T>,
  shouldPrune: (handle: string) => boolean
): Map<string, T> {
  let next: Map<string, T> | null = null
  for (const handle of previous.keys()) {
    if (!shouldPrune(handle)) {
      continue
    }
    next ??= new Map(previous)
    next.delete(handle)
  }
  return next ?? previous
}
