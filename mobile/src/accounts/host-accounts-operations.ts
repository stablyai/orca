import type {
  AccountsSnapshot,
  ProviderKey,
  RateLimitRuntimeTarget
} from '../components/account-usage-state'
import type { CodexResetCreditRequestResult } from '../components/codex-reset-credit'
import type { CodexResetCreditExpectedScope } from '../../../src/shared/codex-reset-credit-scope'

export type HostAccountsOperations = {
  loadHostName(hostId: string): Promise<string | null>
  snapshot(): Promise<AccountsSnapshot>
  select(
    provider: ProviderKey,
    accountId: string | null,
    codexTarget?: RateLimitRuntimeTarget | null
  ): Promise<void>
  readCodexResetCreditCapability(): Promise<boolean>
  consumeCodexResetCredit(
    expectedScope: CodexResetCreditExpectedScope
  ): Promise<CodexResetCreditRequestResult>
  subscribe(listener: (snapshot: AccountsSnapshot) => void, onInvalid?: () => void): () => void
}
