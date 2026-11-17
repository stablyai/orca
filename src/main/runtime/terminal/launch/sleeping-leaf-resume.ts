// Restart of a cloud agent pane (desktop: terminal.stopExact with keepHistory, then terminal.ensureAgentSession
// with the pane's provider session and its tab/leaf placement): the stopped PTY still owns the leaf, so the
// launch adopted it and woke it with its ORIGINAL argv, dropping `--resume <id>` and starting a new
// conversation. An explicit resume replaces a leaf whose PTY isn't running instead; a live pane is still
// adopted (nothing to restart), and plain reconnects without a provider session keep waking the original.

/** The leaf's PTY to replace for an explicit resume, or undefined to adopt as before. */
export function sleepingLeafPtyToReplace(
  leaf: { readonly ptyId?: string | null; readonly connected: boolean } | undefined
): string | undefined {
  return leaf?.ptyId && !leaf.connected ? leaf.ptyId : undefined
}

/** Adoption args for a launch: an explicit resume names the leaf's stopped PTY so it isn't woken. */
export function stoppedLeafForResume(
  launch: { readonly resumeProviderSession?: unknown },
  leaf: { readonly ptyId?: string | null; readonly connected: boolean } | undefined
): { stoppedPtyId?: string } {
  const ptyId = launch.resumeProviderSession ? sleepingLeafPtyToReplace(leaf) : undefined
  return ptyId ? { stoppedPtyId: ptyId } : {}
}

export function throwIfClientDisconnected(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error('client_disconnected')
  }
}
