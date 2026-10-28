/**
 * Every process in a distro, with the pane key and folder of Orca's pane processes, read with
 * one `wsl.exe` launch for a WSL move's busy check. Callers asking at once share that launch.
 */
import {
  parseWslGuestPaneProcesses,
  WSL_GUEST_PANE_PROCESS_SCRIPT,
  type WslGuestProcessRow
} from '../persistence/moving-wsl-projects/wsl-move-guest-foreground'
import { runWslProcess } from './wsl-runner'

const readsInFlight = new Map<string, Promise<WslGuestProcessRow[] | null>>()

/** Null when the distro could not be read in full. */
export function readWslGuestProcessTable(distro: string): Promise<WslGuestProcessRow[] | null> {
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
    maxOutputBytes: 4_194_304
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
