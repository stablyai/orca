import type { prepareClaudeWslDefaultGuest } from './claude-profile-wsl-default'
import {
  ClaudeProfileHostUnreachableError,
  type ClaudeProfileHostAccess
} from './claude-profile-routing-owner'
import type {
  ClaudeWslGuest,
  ClaudeWslProfileResponse,
  prepareClaudeWslGuest
} from './claude-profile-wsl-transport'

export type ClaudeWslGuestCache = Map<
  string,
  { guest: ClaudeWslGuest; expires: number; managed: boolean }
>

const GUEST_TTL_MS = 600_000

/**
 * Inspects a distro through its cached guest. System Default falls back to the no-runtime guest
 * when the managed one cannot start, and that failure is not retried for System Default until it
 * expires, since each retry could wait out the full prepare timeout. Selecting a managed account
 * always tries the managed guest.
 */
export async function inspectClaudeWslGuest(args: {
  guests: ClaudeWslGuestCache
  managedGuestFailures: Map<string, number>
  prepareGuest: typeof prepareClaudeWslGuest
  prepareDefault: typeof prepareClaudeWslDefaultGuest
  distro: string
  managed: boolean
  accountId: string | null
  /** Bypass the System Default fallback: observing a login needs the managed guest's read. */
  requireManaged?: boolean
  accountIds: string[]
  access?: ClaudeProfileHostAccess
}): Promise<{ guest: ClaudeWslGuest; result: ClaudeWslProfileResponse }> {
  const { guests, managedGuestFailures, distro, managed, accountId, access } = args
  const key = distro.toLowerCase()
  const inspect = async (useManaged: boolean) => {
    const cached = guests.get(key)
    const guest =
      cached && cached.managed === useManaged && cached.expires > Date.now()
        ? cached.guest
        : await (useManaged ? args.prepareGuest : args.prepareDefault)(distro, access)
    if (guest !== cached?.guest) {
      guests.set(key, { guest, expires: Date.now() + GUEST_TTL_MS, managed: useManaged })
    }
    const result = await guest.request(
      {
        action: 'inspect',
        distro,
        accountId,
        accountIds: args.accountIds,
        userHome: guest.home,
        hooksEnabled: false
      },
      access
    )
    return { guest, result }
  }
  const skipManaged =
    !args.requireManaged && accountId === null && (managedGuestFailures.get(key) ?? 0) > Date.now()
  try {
    const inspected = await inspect(managed && !skipManaged)
    if (managed && !skipManaged) {
      managedGuestFailures.delete(key)
    }
    return inspected
  } catch (error) {
    // Why: System Default needs only its pointer; the managed runtime failing must not block it.
    if (
      !managed ||
      accountId !== null ||
      args.requireManaged ||
      error instanceof ClaudeProfileHostUnreachableError
    ) {
      throw error
    }
    console.warn('[claude-profile] WSL System Default publishes without the managed guest:', error)
    managedGuestFailures.set(key, Date.now() + GUEST_TTL_MS)
    return inspect(false)
  }
}
