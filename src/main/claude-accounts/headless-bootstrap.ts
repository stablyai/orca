import { getProcessPassphraseHolder } from './secrets-storage/passphrase-prompt'
import { loadClaudeAccountServiceHeadless } from './service'
import type { AddClaudeAccountInput } from '../../shared/types'

// Why: when invoked without a running Orca app, the CLI runs in a stripped-down
// main process that cannot show Electron modals. We accept a passphrase only
// via ORCA_SECRETS_PASSPHRASE so transcripts and ps never see it via argv.
function primePassphraseFromEnvIfPresent(): void {
  const fromEnv = process.env.ORCA_SECRETS_PASSPHRASE
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    getProcessPassphraseHolder().set(fromEnv)
  }
}

export async function runHeadlessClaudeAccountsAdd(
  input: AddClaudeAccountInput
): Promise<{ accountId: string; email: string; accounts: unknown[]; activeAccountId?: string }> {
  primePassphraseFromEnvIfPresent()
  const service = await loadClaudeAccountServiceHeadless()
  return service.addAccount(input)
}

export async function runHeadlessClaudeAccountsList(): Promise<{ accounts: unknown[] }> {
  primePassphraseFromEnvIfPresent()
  const service = await loadClaudeAccountServiceHeadless()
  return service.list()
}

export async function runHeadlessClaudeAccountsSelect(
  accountId: string
): Promise<{ activeAccountId: string }> {
  primePassphraseFromEnvIfPresent()
  const service = await loadClaudeAccountServiceHeadless()
  return service.selectAccount(accountId)
}

export async function runHeadlessClaudeAccountsRemove(
  accountId: string
): Promise<{ removed: boolean }> {
  primePassphraseFromEnvIfPresent()
  const service = await loadClaudeAccountServiceHeadless()
  return service.removeAccount(accountId)
}
