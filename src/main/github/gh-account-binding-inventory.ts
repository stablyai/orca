/**
 * Repo-scoped inventory + validation for Settings GitHub account binding.
 */
import { diagnoseGhAuth } from './auth-diagnose'
import {
  getGhMultiAccountCapability,
  invalidateGhMultiAccountCapability,
  normalizeGhCapabilityTarget,
  type GhCapabilityTarget
} from './gh-capability-state'
import { invalidateGhAccountTokenCache, resolveGhAccountToken } from './gh-account-token'
import { normalizeGhAccountBinding } from '../../shared/github/account-binding'
import type {
  GhAccountBindingInventory,
  GhAccountBindingValidationResult
} from '../../shared/github/auth-types'
import type { LocalGitExecOptions } from './github-repository-identity'

function capabilityTargetFromLocalGitOptions(
  localGitOptions: LocalGitExecOptions = {}
): GhCapabilityTarget {
  return normalizeGhCapabilityTarget(
    localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {}
  )
}

/** Lists keyring logins on the repo's execution host, filtered to `requiredHost` when the repo pins one. */
export async function listGhAccountBindingInventory(
  localGitOptions: LocalGitExecOptions = {},
  options: { refreshCapability?: boolean; requiredHost?: string } = {}
): Promise<GhAccountBindingInventory> {
  const target = capabilityTargetFromLocalGitOptions(localGitOptions)
  if (options.refreshCapability) {
    invalidateGhMultiAccountCapability(target)
    invalidateGhAccountTokenCache()
  }
  const requiredHost = options.requiredHost?.trim().toLowerCase() || undefined
  const [capability, diagnostic] = await Promise.all([
    getGhMultiAccountCapability(target),
    diagnoseGhAuth(requiredHost, {
      cwd: target.cwd,
      wslDistro: target.wslDistro
    })
  ])
  const accounts = requiredHost
    ? diagnostic.accounts.filter((entry) => entry.host.trim().toLowerCase() === requiredHost)
    : diagnostic.accounts
  return {
    capability,
    accounts
  }
}

/** Fails closed: a binding is only `ok` when the CLI supports multi-account and the login exists on this host. */
export async function validateGhAccountBinding(
  bindingInput: { host: string; user: string },
  localGitOptions: LocalGitExecOptions = {},
  options: { requiredHost?: string } = {}
): Promise<GhAccountBindingValidationResult> {
  const binding = normalizeGhAccountBinding(bindingInput)
  if (!binding) {
    return { ok: false, error: 'invalid_binding' }
  }

  const requiredHost = options.requiredHost?.trim().toLowerCase() || undefined
  if (requiredHost && binding.host !== requiredHost) {
    return { ok: false, error: 'gh_bound_account_unavailable' }
  }

  const inventory = await listGhAccountBindingInventory(localGitOptions, { requiredHost })
  if (inventory.capability === 'unsupported') {
    return { ok: false, error: 'gh_multi_account_unsupported' }
  }
  if (inventory.capability === 'unknown') {
    return { ok: false, error: 'gh_multi_account_capability_unknown' }
  }

  const account = inventory.accounts.find(
    (entry) =>
      entry.host.trim().toLowerCase() === binding.host &&
      entry.user.trim().toLowerCase() === binding.user.toLowerCase()
  )
  if (!account) {
    return { ok: false, error: 'gh_bound_account_unavailable' }
  }
  if (account.source !== 'keyring') {
    return { ok: false, error: 'gh_bound_account_not_keyring' }
  }

  try {
    await resolveGhAccountToken(binding, capabilityTargetFromLocalGitOptions(localGitOptions))
    return { ok: true, binding }
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'gh_multi_account_unsupported'
    ) {
      return { ok: false, error: 'gh_multi_account_unsupported' }
    }
    return { ok: false, error: 'gh_bound_account_unavailable' }
  }
}
