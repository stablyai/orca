import { normalizeGhAccountBinding } from '../../../shared/github/account-binding'
import type { GhExecOptions } from './gh-exec-file'
import { collectGhArgvHostSignals } from './gh-host-args'
import type { ResolvedCommand } from './wsl-command-resolution'
import type { GhCaptureLifetimeHooks } from './gh-capture-lifetime'

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

/** Pin the host and inject the bound account token into this child only. */
export async function resolveBoundGhExecEnv(
  options: GhExecOptions,
  resolved: ResolvedCommand,
  args: readonly string[],
  hooks?: GhCaptureLifetimeHooks
): Promise<NodeJS.ProcessEnv | undefined> {
  const binding = options.ghAccount
  if (!binding || args[0] === 'auth') {
    return options.env
  }
  // Dynamic import breaks the runner/token-module load cycle.
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
  const target = { cwd: options.cwd, wslDistro: resolved.wsl?.distro ?? options.wslDistro }
  const token = hooks
    ? await resolveGhAccountToken(normalized, target, undefined, hooks)
    : await resolveGhAccountToken(normalized, target)
  return buildBoundGhChildEnv({
    baseEnv: options.env ?? process.env,
    binding: normalized,
    token,
    forWsl: resolved.wsl !== null
  })
}
