/** Whether a known terminal handle should be dropped after a `terminal.list` refresh.
 *
 *  A handle covered by native chat is retained even when the list omits it: the list
 *  drops every handle while the desktop graph reloads (it re-mints handle ids), and
 *  the covered stream IS the input lease — nothing else re-subscribes it, so dropping
 *  it there locks the composer for good (#10681). A genuinely dead PTY still arrives
 *  as an `end`/`error` stream frame, and the chat stream hook bounds its rearms —
 *  a later list that reports the handle again refills that rearm budget, so an
 *  exhausted rearm never locks the composer past the host's recovery. */
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

/** Binds one `terminal.list` refresh's context so callers can test many handles. */
export function createTerminalPrunePredicate(context: {
  liveHandles: ReadonlySet<string>
  showNativeChat: boolean
  activeHandle: string | null
}): (handle: string) => boolean {
  return (handle) => shouldPruneTerminalHandle({ handle, ...context })
}

/** The handles this refresh treats as alive: everything the list reported, plus
 *  whatever the chat retention keeps. Per-handle preferences must be swept with the
 *  same set the subscriptions are, or the refresh that retains a covered handle
 *  still erases its live-input opt-out. */
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

/** Drops per-handle keyboard metrics for pruned terminals, returning `previous`
 *  untouched when nothing changed. Swept over the whole map rather than the handles
 *  the caller just tore down: a handle retained for chat leaves the subscription map
 *  without ever being revisited by that loop. */
export function pruneTerminalKeyboardMetrics<T>(
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
