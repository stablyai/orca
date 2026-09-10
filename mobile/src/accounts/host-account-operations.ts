import type {
  AccountsSnapshot,
  ProviderKey,
  RateLimitRuntimeTarget
} from '../components/account-usage-state'

export type HostAccountOperations = {
  snapshot(): Promise<AccountsSnapshot>
  select(
    provider: ProviderKey,
    accountId: string | null,
    codexTarget?: RateLimitRuntimeTarget | null
  ): Promise<void>
  subscribe(listener: (snapshot: AccountsSnapshot) => void, onInvalid?: () => void): () => void
}
