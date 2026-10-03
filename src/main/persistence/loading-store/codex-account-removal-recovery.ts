import type { CodexManagedAccount } from '../../../shared/managed-account-types'
import type { StoreRuntimeState } from './store-runtime-state'

type CodexAccountRemovalRecoveryRuntime = Pick<
  StoreRuntimeState,
  'state' | 'runDurableMutation' | 'dirtyProfileStateDomains'
>

export function persistCodexAccountRemovalRecovery(
  runtime: CodexAccountRemovalRecoveryRuntime,
  accountId: string,
  account?: CodexManagedAccount
): Promise<void> {
  return runtime.runDurableMutation(() => {
    const previous = runtime.state.settings.codexAccountRemovalRecovery
    const retained = (previous ?? []).filter((entry) => entry.id !== accountId)
    if (!account && retained.length === (previous ?? []).length) {
      return { value: undefined, persist: false }
    }
    const next = account ? [...retained, structuredClone(account)] : retained
    runtime.state.settings = { ...runtime.state.settings, codexAccountRemovalRecovery: next }
    runtime.dirtyProfileStateDomains?.add('settings')
    return {
      value: undefined,
      rollback: () => {
        if (runtime.state.settings.codexAccountRemovalRecovery === next) {
          runtime.state.settings.codexAccountRemovalRecovery = previous
        }
      }
    }
  })
}
