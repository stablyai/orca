/** Frees the "+" lock only for the create holding it, so an older launch can't free a newer one's. */
export function releaseTerminalCreateLock(
  scope: {
    creatingTerminalRef: { current: string | null }
    setCreating: (creating: boolean) => void
  },
  lock: string
): void {
  if (scope.creatingTerminalRef.current !== lock) {
    return
  }
  scope.creatingTerminalRef.current = null
  scope.setCreating(false)
}
