/** A current rendered Hermes frame, never accumulated scrollback. */
export function isHermesReadyPromptSnapshot(screen: string): boolean {
  const visible = screen
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const tail = visible.slice(-8)
  if (
    tail.some((line) =>
      /\b(?:approval required|permission required|do you trust|sign in|select a model|choose a theme|press enter to continue)\b/i.test(
        line
      )
    )
  ) {
    return false
  }
  const statusIndex = tail.findLastIndex((line) => /^[─\s]*ready\s*│/i.test(line))
  const composerIndex = tail.findLastIndex((line) =>
    /^(?:[\p{L}\p{N}_.-]+\s+)?❯(?:\s|$)/u.test(line)
  )
  // A status bar can be above or below the composer, with one live counter row between them.
  return (
    statusIndex !== -1 &&
    composerIndex !== -1 &&
    Math.abs(statusIndex - composerIndex) <= 2 &&
    Math.max(statusIndex, composerIndex) === tail.length - 1
  )
}
