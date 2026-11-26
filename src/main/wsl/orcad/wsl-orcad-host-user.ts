/** Each WSL host's pinned Linux account (#49180): host wsl.exe calls pass it as `-u`, so a default-user change never swaps servers. */
import { wslDistroHolderKey } from '../discovery/wsl-distro-holder-record'

const pinned = new Map<string, string>()
// Set and cleared by one operation (a removal under a new name, a migration's trial connect); record reads never touch them.
const overrides = new Map<string, string>()

/** Replaces the record pins with what the saved records name; records without a user stay unpinned. */
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
  const key = wslDistroHolderKey(distro)
  return overrides.get(key) ?? pinned.get(key)
}

/** Runs `task` with `distro` pinned to `linuxUser`, whatever the records say meanwhile. */
export async function withWslHostLinuxUser<T>(
  distro: string,
  linuxUser: string,
  task: () => Promise<T>
): Promise<T> {
  const key = wslDistroHolderKey(distro)
  const previous = overrides.get(key)
  overrides.set(key, linuxUser)
  try {
    return await task()
  } finally {
    if (previous === undefined) {
      overrides.delete(key)
    } else {
      overrides.set(key, previous)
    }
  }
}
