// Captured Qoder 1.1.64 paints its idle OSC title even while the trust menu owns input.
export function isQoderComposerReady(screenLines: readonly string[] | null): boolean {
  if (!screenLines) {
    return false
  }
  const screen = screenLines.join('\n').toLowerCase()
  return (
    screen.includes('type your message or @path/to/file') &&
    !screen.includes("don't trust and exit")
  )
}
