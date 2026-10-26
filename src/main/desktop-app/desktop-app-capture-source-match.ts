// Electron names window sources `window:<native window id>:<n>`: the CGWindowID on a Mac, the
// HWND on Windows and the X11 window id on Linux, i.e. the windowId the window list returns.
export function findWindowCaptureSource<T extends { id: string }>(
  sources: readonly T[],
  windowId: number
): T | null {
  const prefix = `window:${windowId}:`
  return sources.find((source) => source.id.startsWith(prefix)) ?? null
}

export function describeMissingCaptureSource(
  windowId: number,
  totalWindowSources: number,
  platform: NodeJS.Platform = process.platform
): string {
  // Why: without Screen Recording, macOS hands Electron no window sources at all; elsewhere an
  // empty list means the session cannot capture windows, so only the Mac names a settings path.
  if (totalWindowSources === 0) {
    return platform === 'darwin'
      ? 'Orca cannot see any app windows. Allow Orca in System Settings › Privacy & Security › Screen Recording, then reopen this tab.'
      : 'Orca cannot see any app windows. Check that screen capture is allowed for Orca, then reopen this tab.'
  }
  return `Window ${windowId} is no longer open. Pick the app window again.`
}
