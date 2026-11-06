import { InvalidArgumentError } from '../runtime/rpc/core'
import {
  getClaudeProfileRouter,
  getClaudeWslProfileRouter
} from './claude-profile-installed-router'
import { resolveClaudeOAuthCredentialReadOptions } from '../rate-limits/claude-oauth-credentials'
import { refreshClaudeOAuthAccessToken } from '../rate-limits/claude-oauth-refresh'
import type { ClaudeOAuthRefreshResult } from '../rate-limits/claude-oauth-refresh-state'
import type { ClaudeTokenRefreshNowResult } from '../../shared/managed-account-types'

export type { ClaudeTokenRefreshNowResult }

export type ClaudeTokenRefreshNowAccount = {
  id: string
  email: string
  managedAuthRuntime?: 'host' | 'wsl'
  wslDistro?: string | null
}

export type ClaudeTokenRefreshNowInput = {
  account: string
  force?: boolean
}

export async function refreshOneClaudeAccountToken(
  accounts: readonly ClaudeTokenRefreshNowAccount[],
  input: ClaudeTokenRefreshNowInput
): Promise<ClaudeTokenRefreshNowResult> {
  const account = resolveClaudeTokenRefreshAccount(accounts, input.account)
  const preparation = await preparationFor(account)
  if (!preparation) {
    return { accountId: account.id, email: account.email, outcome: 'failed', reason: 'unreadable' }
  }
  const refreshed = await refreshClaudeOAuthAccessToken({
    accountId: account.id,
    readOptions: resolveClaudeOAuthCredentialReadOptions(preparation),
    force: input.force === true
  })
  return present(account, refreshed)
}

function resolveClaudeTokenRefreshAccount(
  accounts: readonly ClaudeTokenRefreshNowAccount[],
  needle: string
): ClaudeTokenRefreshNowAccount {
  const name = needle.trim()
  const byId = accounts.find((account) => account.id === name)
  if (byId) {
    return byId
  }
  const byEmail = accounts.filter((account) => account.email.toLowerCase() === name.toLowerCase())
  if (byEmail.length > 1) {
    throw new InvalidArgumentError('More than one Claude account uses that email.')
  }
  const found = byEmail[0]
  if (!found) {
    throw new InvalidArgumentError('No Claude account matches that id or email.')
  }
  return found
}

async function preparationFor(account: ClaudeTokenRefreshNowAccount) {
  if (account.managedAuthRuntime === 'wsl') {
    if (!account.wslDistro) {
      return null
    }
    return (
      (await getClaudeWslProfileRouter()?.accountUsagePreparation(account.wslDistro, account.id)) ??
      null
    )
  }
  return getClaudeProfileRouter()?.accountUsagePreparation(account.id) ?? null
}

function present(
  account: ClaudeTokenRefreshNowAccount,
  result: ClaudeOAuthRefreshResult
): ClaudeTokenRefreshNowResult {
  const base = { accountId: account.id, email: account.email }
  if (result.outcome === 'refreshed') {
    return { ...base, outcome: 'ok' }
  }
  if (result.outcome === 'skipped') {
    return { ...base, outcome: 'skipped', reason: result.reason }
  }
  if (result.outcome === 'lapsed') {
    return { ...base, outcome: 'lapsed' }
  }
  return { ...base, outcome: 'failed', reason: result.reason }
}
