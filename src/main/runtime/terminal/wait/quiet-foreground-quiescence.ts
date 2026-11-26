import type { QuietForegroundLane } from './tui-idle-evidence'

/** Open lanes accept missing clocks as uncorroborated quiet for unseen daemon output; caller timeouts remain and delivery cannot use this lane.
 * Known agents on after-paint lanes must first paint their own command output, excluding shell prompts/echo. */
export function isQuietForQuiescence(
  lastOutputAt: number | null,
  quiescenceMs: number,
  lane: QuietForegroundLane,
  commandPainted: () => boolean
): boolean {
  if (lane === 'after-paint' && !commandPainted()) {
    return false
  }
  if (lastOutputAt === null) {
    return lane === 'open'
  }
  return Date.now() - lastOutputAt >= quiescenceMs
}
