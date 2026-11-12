// Captured Qoder 1.1.64 paints its idle OSC title even while the trust menu owns input.
// The composer row only exists in the painted grid: Qoder paints it word-by-word with
// cursor jumps, so neither raw tail bytes nor the preview ever hold it contiguously (#40734).
export function isQoderComposerReady(screenText: string | null): boolean {
  const screen = screenText?.toLowerCase() ?? ''
  return (
    screen.includes('type your message or @path/to/file') &&
    !screen.includes("don't trust and exit")
  )
}
