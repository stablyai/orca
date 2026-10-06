import type { CodexManagedAccountSummary } from '../../shared/managed-account-types'
import type { AgentLaunchAccountReceipt } from '../../shared/agent-launch-account'
import { LaunchAccountParam } from '../../shared/rpc-contract/launch-account-param'

export function resolveCodexLaunchAccount(
  accounts: readonly Pick<CodexManagedAccountSummary, 'id' | 'email' | 'managedHomeRuntime'>[],
  selector: string
): AgentLaunchAccountReceipt {
  const parsed = LaunchAccountParam.safeParse(selector)
  if (!parsed.success) {
    throw new Error('--account requires a Codex account id, unique email, or system.')
  }
  const requested = parsed.data
  const byId = accounts.find((account) => account.id === requested)
  if (!byId && /^(system|system default)$/i.test(requested)) {
    return { provider: 'codex', requested: 'system', effective: { id: null, email: null } }
  }
  const matches = byId
    ? [byId]
    : accounts.filter(
        (account) =>
          account.managedHomeRuntime !== 'wsl' &&
          account.email.trim().toLowerCase() === requested.toLowerCase()
      )
  if (matches.length === 0) {
    throw new Error(
      'No managed Codex account matches --account on this host. Use an existing account id or email.'
    )
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous Codex account email; pass an exact id: ${matches.map((account) => account.id).join(', ')}.`
    )
  }
  const account = matches[0]
  if (account.managedHomeRuntime === 'wsl') {
    throw new Error(
      '--account supports native host Codex accounts only; WSL accounts are unsupported.'
    )
  }
  return {
    provider: 'codex',
    requested: byId ? account.id : account.email.trim().toLowerCase(),
    effective: { id: account.id, email: account.email }
  }
}
