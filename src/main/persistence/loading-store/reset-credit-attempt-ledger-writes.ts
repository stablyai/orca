import type { PersistedState } from '../../../shared/persisted-state-types'
import type { StoreRuntimeState } from './store-runtime-state'

type ResetCreditLedgerKey = 'codexResetCreditAttemptLedger' | 'grokResetCreditAttemptLedger'

type ResetCreditLedgerWriteRuntime = Pick<
  StoreRuntimeState,
  'flushOrThrow' | 'state' | 'writesFrozen'
>

export function replaceResetCreditAttemptLedgerAndFlush<
  Key extends ResetCreditLedgerKey,
  Ledger extends NonNullable<PersistedState[Key]>
>(
  runtime: ResetCreditLedgerWriteRuntime,
  options: {
    key: Key
    ledger: Ledger
    parse: (value: unknown) => Ledger
    providerLabel: string
  }
): void {
  if (runtime.writesFrozen) {
    throw new Error(
      `Cannot persist ${options.providerLabel} reset-credit attempts while writes are frozen`
    )
  }
  const next = options.parse(options.ledger)
  const previous = runtime.state[options.key]
    ? structuredClone(runtime.state[options.key])
    : undefined
  runtime.state[options.key] = next
  // Why: provider mutation may start only after this synchronous durability barrier succeeds.
  try {
    runtime.flushOrThrow()
  } catch (error) {
    runtime.state[options.key] = previous
    throw error
  }
}
