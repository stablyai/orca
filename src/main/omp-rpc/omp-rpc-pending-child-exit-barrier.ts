export function trackPendingChildExit(
  pendingChildExits: Set<Promise<void>>,
  childExit: Promise<void>
): void {
  pendingChildExits.add(childExit)
  void childExit.finally(() => pendingChildExits.delete(childExit))
}
