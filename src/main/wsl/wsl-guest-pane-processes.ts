/**
 * Every process in a distro with its Orca pane key and folder, read with one `wsl.exe` launch.
 * Callers asking at once (a move's gate, the panes of one worktree's Sleep) share that launch.
 */
import {
  parseWslGuestPaneProcesses,
  WSL_GUEST_PANE_PROCESS_SCRIPT,
  type WslGuestProcessRow
} from '../persistence/moving-wsl-projects/wsl-move-guest-foreground'
import { runWslProcess } from './wsl-runner'

const readsInFlight = new Map<string, Promise<WslGuestProcessRow[] | null>>()

/** Null when the distro could not be read in full. */
export function readWslGuestPaneProcesses(distro: string): Promise<WslGuestProcessRow[] | null> {
  // WSL resolves distro names case-insensitively.
  const key = distro.toLowerCase()
  const inFlight = readsInFlight.get(key)
  if (inFlight) {
    return inFlight
  }
  const read = runWslProcess({
    distro,
    script: WSL_GUEST_PANE_PROCESS_SCRIPT,
    loginPath: 'none',
    timeoutMs: 5_000,
    maxOutputBytes: 1_048_576
  })
    .then((result) =>
      result.code !== 0 || result.timedOut || result.outputTruncated
        ? null
        : parseWslGuestPaneProcesses(result.stdout)
    )
    .catch(() => null)
    .finally(() => readsInFlight.delete(key))
  readsInFlight.set(key, read)
  return read
}
