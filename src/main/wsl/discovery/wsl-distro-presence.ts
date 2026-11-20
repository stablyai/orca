import { runProcess } from '@orca/process-host'
import { WSL_PROBE_TIMEOUT_MS, wslExeProcessSpec } from '../execution/wsl-exe-process'
import { parseWslDistros } from './wsl-distro-list-output'
import { lxssRegQuerySpec, parseWslDistroRegistrations } from './wsl-distro-registry-id'

type WslDistroPresence = 'installed' | 'gone' | 'unknown'

function isListed(distros: readonly string[], distro: string): boolean {
  const wanted = distro.toLowerCase()
  return distros.some((listed) => listed.toLowerCase() === wanted)
}

/** Read fresh, never from the catalog cache: a just-unregistered distro must read as gone. */
async function readWslDistroPresence(distro: string): Promise<WslDistroPresence> {
  try {
    const list = await runProcess(wslExeProcessSpec(['--list', '--quiet'], WSL_PROBE_TIMEOUT_MS))
    const listed = list.code === 0 ? parseWslDistros(list.stdout) : []
    // An empty or failed list can be lost output (#35509) or no distros at all; the registry tells.
    if (listed.length > 0) {
      return isListed(listed, distro) ? 'installed' : 'gone'
    }
  } catch (error) {
    // Explicit cwd rules out a deleted inherited directory, so ENOENT means WSL itself is gone.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return 'gone'
    }
  }
  try {
    const registry = await runProcess(lxssRegQuerySpec())
    if (registry.code !== 0) {
      return 'unknown'
    }
    const registered = parseWslDistroRegistrations(registry.stdout).map(({ distro }) => distro)
    return isListed(registered, distro) ? 'installed' : 'gone'
  } catch {
    return 'unknown'
  }
}

/** A failed guest cleanup stands unless the distro, or WSL itself, is confirmed gone. */
export async function cleanUpUnlessWslDistroGone(
  distro: string,
  cleanUp: () => Promise<void>
): Promise<void> {
  try {
    await cleanUp()
  } catch (error) {
    if ((await readWslDistroPresence(distro)) !== 'gone') {
      throw error
    }
    console.warn(`[wsl] ${distro} is no longer installed; skipped cleaning it up:`, error)
  }
}
