/** Each WSL host's pinned Linux account (#49180): host wsl.exe calls pass it as `-u`, so a default-user change never swaps servers. */
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

/** Adds one more name for a pinned host (a renamed distro) until the next records read. */
export function pinWslHostLinuxUser(distro: string, linuxUser: string): void {
  pinned.set(wslDistroHolderKey(distro), linuxUser)
}
