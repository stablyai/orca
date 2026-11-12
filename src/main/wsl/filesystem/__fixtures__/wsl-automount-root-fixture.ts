import { followWslAutomountRoots, ensureWslAutomountRoot } from '../wsl-automount-root'
import { resolveRunningWslDistros } from '../../discovery/wsl-running-distro-cache'

/** Feed an authoritative guest root through the production follower without a real WSL process. */
export async function settleWslAutomountRoot(distro = 'Ubuntu', root = '/mnt/'): Promise<void> {
  const stop = followWslAutomountRoots(
    () => [distro],
    async () => root
  )
  try {
    await resolveRunningWslDistros(async () => [distro])
    await ensureWslAutomountRoot(distro)
  } finally {
    stop()
  }
}
