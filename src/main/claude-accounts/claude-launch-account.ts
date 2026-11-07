import type { ClaudeRateLimitAccountsState } from '../../shared/managed-account-types'

export type ClaudeLaunchAccountResolution = {
  accountId: string
  email: string
  /** The host's selected account; a launch on it takes the normal (unpinned) path. */
  isActiveOnHost: boolean
}

export class ClaudeLaunchAccountError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClaudeLaunchAccountError'
  }
}

/**
 * Resolves `--account <id|email>` against this host's managed Claude accounts.
 *
 * An exact id wins over an email so an id can always disambiguate; emails compare
 * case-insensitively because providers normalize them and users type them either way.
 */
export function resolveClaudeLaunchAccount(
  state: Pick<ClaudeRateLimitAccountsState, 'accounts' | 'activeAccountId'>,
  selector: string
): ClaudeLaunchAccountResolution {
  const requested = selector.trim()
  if (!requested) {
    throw new ClaudeLaunchAccountError('--account requires a Claude account id or email.')
  }
  const byId = state.accounts.find((account) => account.id === requested)
  const normalizedEmail = requested.toLowerCase()
  const matches = byId
    ? [byId]
    : state.accounts.filter((account) => account.email.trim().toLowerCase() === normalizedEmail)
  if (matches.length === 0) {
    throw new ClaudeLaunchAccountError(
      `No managed Claude account matches "${requested}". Run \`orca account list\` to see the account ids and emails on this host.`
    )
  }
  if (matches.length > 1) {
    throw new ClaudeLaunchAccountError(
      `More than one managed Claude account uses ${requested} (${matches.map((account) => account.id).join(', ')}). Pass --account <id> instead.`
    )
  }
  const account = matches[0]
  if (account.managedAuthRuntime === 'wsl') {
    // Why: a WSL account's credentials live inside the distro; the pinned launch only knows how
    // to hand a host config dir to a host Claude.
    throw new ClaudeLaunchAccountError(
      `Claude account ${account.email} (${account.id}) is a WSL account; --account supports host accounts only.`
    )
  }
  return {
    accountId: account.id,
    email: account.email,
    isActiveOnHost: state.activeAccountId === account.id
  }
}
