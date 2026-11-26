/**
 * The Linux account each WSL host's orcad runs as, pinned when the host was added (#49180). Every
 * host wsl.exe call passes it as `-u`, so changing the distro's default user later never starts a
 * second orcad (another home, another host key) that the saved pairing would refuse.
 */
import { wslDistroHolderKey } from '../discovery/wsl-distro-holder-record'

const pinned = new Map<string, string>()

/** Replaces the pins with what the saved records name; records without a user stay unpinned. */
export function pinWslHostLinuxUsers(
  records: readonly { distro: string; linuxUser?: string }[]
): void {
  pinned.clear()
  for (const { distro, linuxUser } of records) {
    if (linuxUser) {
      pinned.set(wslDistroHolderKey(distro), linuxUser)
    }
  }
}

/** The account to run host commands as; undefined runs as the distro's default user (an Add). */
export function pinnedWslHostLinuxUser(distro: string): string | undefined {
  return pinned.get(wslDistroHolderKey(distro))
}
