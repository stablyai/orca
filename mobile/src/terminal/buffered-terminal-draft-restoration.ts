export type BufferedTerminalDraftValue = string | ((current: string) => string)
export type BufferedTerminalDraftRestorationToken = { handle: string }

export function updateBufferedTerminalDraft(
  currentDrafts: Record<string, string>,
  handle: string | null,
  value: BufferedTerminalDraftValue
): Record<string, string> {
  if (!handle) {
    return currentDrafts
  }
  const current = currentDrafts[handle] ?? ''
  const next = typeof value === 'function' ? value(current) : value
  return next === current ? currentDrafts : { ...currentDrafts, [handle]: next }
}

export function beginBufferedTerminalDraftRestoration(
  pendingRestorations: Map<string, BufferedTerminalDraftRestorationToken>,
  handle: string
): BufferedTerminalDraftRestorationToken {
  const token = { handle }
  pendingRestorations.set(handle, token)
  return token
}

export function invalidateBufferedTerminalDraftRestoration(
  pendingRestorations: Map<string, BufferedTerminalDraftRestorationToken>,
  handle: string
): void {
  pendingRestorations.delete(handle)
}

export function settleBufferedTerminalDraftRestoration(
  pendingRestorations: Map<string, BufferedTerminalDraftRestorationToken>,
  handle: string,
  token: BufferedTerminalDraftRestorationToken
): boolean {
  const currentHandle = pendingRestorations.get(handle) === token ? handle : token.handle
  if (pendingRestorations.get(currentHandle) !== token) {
    return false
  }
  pendingRestorations.delete(currentHandle)
  return true
}

export function remapBufferedTerminalDraftRestoration(
  pendingRestorations: Map<string, BufferedTerminalDraftRestorationToken>,
  previousHandle: string,
  nextHandle: string
): void {
  const token = pendingRestorations.get(previousHandle)
  if (!token || pendingRestorations.has(nextHandle)) {
    pendingRestorations.delete(previousHandle)
    return
  }
  pendingRestorations.delete(previousHandle)
  token.handle = nextHandle
  pendingRestorations.set(nextHandle, token)
}

export function remapBufferedTerminalDraft(
  currentDrafts: Record<string, string>,
  previousHandle: string,
  nextHandle: string
): Record<string, string> {
  if (previousHandle === nextHandle || !Object.hasOwn(currentDrafts, previousHandle)) {
    return currentDrafts
  }
  const next = { ...currentDrafts }
  if (!Object.hasOwn(currentDrafts, nextHandle)) {
    next[nextHandle] = currentDrafts[previousHandle] ?? ''
  }
  delete next[previousHandle]
  return next
}

/** Restore a rejected send without overwriting text composed while its RPC was in flight. */
export function restoreRejectedBufferedTerminalDraft(
  currentDrafts: Record<string, string>,
  originHandle: string,
  rejectedDraft: string
): Record<string, string> {
  if ((currentDrafts[originHandle] ?? '').length > 0) {
    return currentDrafts
  }
  return updateBufferedTerminalDraft(currentDrafts, originHandle, rejectedDraft)
}

export function pruneBufferedTerminalDrafts(
  currentDrafts: Record<string, string>,
  retainedHandles: ReadonlySet<string>
): Record<string, string> {
  let next = currentDrafts
  for (const handle of Object.keys(currentDrafts)) {
    if (retainedHandles.has(handle)) {
      continue
    }
    if (next === currentDrafts) {
      next = { ...currentDrafts }
    }
    delete next[handle]
  }
  return next
}

export function pruneBufferedTerminalDraftRestorations(
  pendingRestorations: Map<string, BufferedTerminalDraftRestorationToken>,
  retainedHandles: ReadonlySet<string>
): void {
  for (const handle of pendingRestorations.keys()) {
    if (!retainedHandles.has(handle)) {
      pendingRestorations.delete(handle)
    }
  }
}
