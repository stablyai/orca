/** Each WSL host's pinned Linux account (#49180): host wsl.exe calls pass it as `-u`, so a default-user change never swaps servers. */
import { wslDistroHolderKey } from '../discovery/wsl-distro-holder-record'

const pinned = new Map<string, string>()
// Until a records read succeeds, nothing is known: never treat a pinned holder as another account's.
let loaded = false
// Each operation's own entry (a removal under a new name, a migration's trial): record reads never touch them.
const overrides = new Map<string, { token: symbol; linuxUser: string }[]>()

/** Replaces the record pins with what the saved records name; records without a user stay unpinned. */
export function pinWslHostLinuxUsers(
  records: readonly { distro: string; linuxUser?: string }[]
): void {
  pinned.clear()
  loaded = true
  for (const { distro, linuxUser } of records) {
    if (linuxUser) {
      pinned.set(wslDistroHolderKey(distro), linuxUser)
    }
  }
}

/** Pins one host as its record now says, ahead of the next records read. */
export function pinWslHostLinuxUser(distro: string, linuxUser: string): void {
  pinned.set(wslDistroHolderKey(distro), linuxUser)
}

/** The account to run host commands as; undefined runs as the distro's default user (an Add). */
export function pinnedWslHostLinuxUser(distro: string): string | undefined {
  const key = wslDistroHolderKey(distro)
  return overrides.get(key)?.at(-1)?.linuxUser ?? pinned.get(key)
}

/** The pinned account, or null while no records read has succeeded yet. */
export function knownWslHostLinuxUser(distro: string): string | undefined | null {
  return loaded || overrides.has(wslDistroHolderKey(distro)) ? pinnedWslHostLinuxUser(distro) : null
}

/** Runs `task` with `distro` pinned to `linuxUser`, whatever the records say meanwhile. */
export async function withWslHostLinuxUser<T>(
  distro: string,
  linuxUser: string,
  task: () => Promise<T>
): Promise<T> {
  const key = wslDistroHolderKey(distro)
  const entry = { token: Symbol(key), linuxUser }
  overrides.set(key, [...(overrides.get(key) ?? []), entry])
  try {
    return await task()
  } finally {
    // Only this operation's entry goes: a concurrent one keeps its own.
    const rest = (overrides.get(key) ?? []).filter((other) => other.token !== entry.token)
    if (rest.length > 0) {
      overrides.set(key, rest)
    } else {
      overrides.delete(key)
    }
  }
}
