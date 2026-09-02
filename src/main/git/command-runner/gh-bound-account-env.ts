import { normalizeGhAccountBinding } from '../../../shared/github/account-binding'
import type { GhExecOptions } from './gh-exec-file'
import { collectGhArgvHostSignals } from './gh-host-args'
import type { ResolvedCommand } from './wsl-command-resolution'

const GH_BOUND_ACCOUNT_ERROR_CODES = new Set([
  'gh_bound_account_unavailable',
  'gh_bound_account_host_mismatch',
  'gh_multi_account_unsupported'
])

/** True for the fail-closed errors raised while resolving a bound account, before any gh child ran. */
export function isGhBoundAccountError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    GH_BOUND_ACCOUNT_ERROR_CODES.has(error.code)
  )
}

/**
 * Child env for a bound gh call: pins the host, resolves the bound login's
 * token, and injects it into this child only — never process-wide.
 */
export async function resolveBoundGhExecEnv(
  options: GhExecOptions,
  resolved: ResolvedCommand,
  args: readonly string[]
): Promise<NodeJS.ProcessEnv | undefined> {
  const binding = options.ghAccount
  if (!binding || args[0] === 'auth') {
    return options.env
  }
  // Why: dynamic import avoids a load-time cycle (command runner ↔ github token module).
  const {
    buildBoundGhChildEnv,
    createGhBoundAccountHostMismatchError,
    createGhBoundAccountUnavailableError,
    resolveGhAccountToken
  } = await import('../../github/gh-account-token')
  const normalized = normalizeGhAccountBinding(binding)
  if (!normalized) {
    throw createGhBoundAccountUnavailableError(binding)
  }
  const optionsHost = options.host?.trim().toLowerCase()
  if (!optionsHost || optionsHost !== normalized.host) {
    throw createGhBoundAccountHostMismatchError(normalized, options.host)
  }
  for (const host of collectGhArgvHostSignals(args)) {
    if (host !== normalized.host) {
      throw createGhBoundAccountHostMismatchError(normalized, host)
    }
  }
  const token = await resolveGhAccountToken(normalized, {
    cwd: options.cwd,
    wslDistro: resolved.wsl?.distro ?? options.wslDistro
  })
  return buildBoundGhChildEnv({
    baseEnv: options.env ?? process.env,
    binding: normalized,
    token,
    forWsl: resolved.wsl !== null
  })
}
