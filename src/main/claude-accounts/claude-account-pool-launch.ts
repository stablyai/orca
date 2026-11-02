import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ClaudeManagedAccountSummary } from '../../shared/managed-account-types'
import type { InactiveAccountUsage, ProviderRateLimits } from '../../shared/rate-limit-types'
import { isClaudeUsageReadingOf } from './claude-account-auto-switch'
import {
  chooseClaudePoolAccount,
  type ClaudePoolAccount,
  type ClaudePoolUsage
} from './claude-account-pool-policy'
import {
  listClaudePaneAccounts,
  type ClaudePaneAccountRecord
} from './claude-pane-account-registry'
import {
  getSelectedClaudeAccountIdForTarget,
  normalizeClaudeAccountSelectionTarget,
  type ClaudeAccountSelectionTarget
} from './runtime-selection'

export type ClaudePoolLaunchDecision = {
  accountId: string
  /** Use the named account's launch env. False when the selected-account launch already matches. */
  named: boolean
}

type ClaudePoolLaunchRead = (
  target: ClaudeAccountSelectionTarget
) => ClaudePoolLaunchDecision | null

let readLaunch: ClaudePoolLaunchRead | null = null

export function installClaudePoolLaunchRead(read: ClaudePoolLaunchRead | null): void {
  readLaunch = read
}

export function claudePoolAccountForLaunch(
  target: ClaudeAccountSelectionTarget
): ClaudePoolLaunchDecision | null {
  return readLaunch?.(target) ?? null
}

/** Live panes per account. Pinned panes are counted apart so the pool can leave their account alone. */
export function claudePoolSessionCounts(
  records: readonly Pick<ClaudePaneAccountRecord, 'accountId' | 'assignedAccountId' | 'pinned'>[]
): { assignedCounts: Record<string, number>; pinnedCounts: Record<string, number> } {
  const assignedCounts: Record<string, number> = {}
  const pinnedCounts: Record<string, number> = {}
  for (const record of records) {
    // Same account the registry bills: the proxy assignment when one exists.
    const id = record.assignedAccountId ?? record.accountId
    assignedCounts[id] = (assignedCounts[id] ?? 0) + 1
    if (record.pinned) {
      pinnedCounts[id] = (pinnedCounts[id] ?? 0) + 1
    }
  }
  return { assignedCounts, pinnedCounts }
}

function sameRuntime(
  account: ClaudeManagedAccountSummary,
  target: ClaudeAccountSelectionTarget
): boolean {
  const accountTarget = normalizeClaudeAccountSelectionTarget({
    runtime: account.managedAuthRuntime,
    wslDistro: account.wslDistro
  })
  const launchTarget = normalizeClaudeAccountSelectionTarget(target)
  return (
    accountTarget.runtime === launchTarget.runtime &&
    accountTarget.wslDistro === launchTarget.wslDistro
  )
}

export function claudePoolInputsForTarget(input: {
  accounts: readonly ClaudeManagedAccountSummary[]
  selectedAccountId: string | null
  target: ClaudeAccountSelectionTarget
  selectedLimits: ProviderRateLimits | null
  inactive: readonly InactiveAccountUsage[]
  failureHoldUntil?: Readonly<Record<string, number>>
}): { accounts: ClaudePoolAccount[]; usage: ClaudePoolUsage[] } {
  const accounts = input.accounts
    .filter((account) => sameRuntime(account, input.target))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const usage: ClaudePoolUsage[] = []
  for (const account of accounts) {
    // The selected account's bar wins over an inactive row, same as claudeUsageForAccount.
    if (account.id === input.selectedAccountId) {
      if (input.selectedLimits && isClaudeUsageReadingOf(input.selectedLimits, account)) {
        usage.push({
          accountId: account.id,
          rateLimits: input.selectedLimits,
          updatedAt: input.selectedLimits.updatedAt
        })
      }
      continue
    }
    const inactive = input.inactive.find((row) => row.accountId === account.id)
    if (inactive) {
      usage.push({
        accountId: account.id,
        rateLimits: inactive.rateLimits,
        updatedAt: inactive.updatedAt
      })
    }
  }
  return {
    accounts: accounts.map((account) => ({
      id: account.id,
      signedIn: account.needsSignIn !== true,
      ...(account.id === input.selectedAccountId ? { selected: true } : {}),
      ...(input.failureHoldUntil?.[account.id] !== undefined
        ? { failureHoldUntil: input.failureHoldUntil[account.id] }
        : {})
    })),
    usage
  }
}

/** Reads the live accounts, usage, and pane registry when the pool setting is on. */
export function bindClaudePoolLaunchToServices(services: {
  getSettings: () => Partial<
    Pick<
      GlobalSettings,
      | 'claudeAccountPool'
      | 'activeClaudeManagedAccountId'
      | 'activeClaudeManagedAccountIdsByRuntime'
    >
  >
  listAccounts: () => { accounts: readonly ClaudeManagedAccountSummary[] }
  getRateLimits: () => {
    claude: ProviderRateLimits | null
    inactiveClaudeAccounts: readonly InactiveAccountUsage[]
  }
}): void {
  installClaudePoolLaunchRead((target) => {
    const settings = services.getSettings()
    if (settings.claudeAccountPool !== 'on') {
      return null
    }
    const selectedAccountId = getSelectedClaudeAccountIdForTarget(settings, target)
    const state = services.getRateLimits()
    const inputs = claudePoolInputsForTarget({
      accounts: services.listAccounts().accounts,
      selectedAccountId,
      target,
      selectedLimits: state.claude,
      inactive: state.inactiveClaudeAccounts
    })
    const counts = claudePoolSessionCounts(listClaudePaneAccounts())
    const choice = chooseClaudePoolAccount({
      ...inputs,
      ...counts,
      now: Date.now()
    })
    if (!choice) {
      return null
    }
    return {
      accountId: choice.accountId,
      named: choice.kind === 'chosen' && choice.accountId !== selectedAccountId
    }
  })
}
