import { CodexHookService } from './codex-hook-service-implementation'
import { cleanupLegacySystemManagedHooks } from './codex-hook-legacy-cleanup'
import { getManagedScript } from './codex-hook-script'
import { removeStaleWslRuntimeManagedHookTrustEntries } from './codex-hook-trust-cleanup'
import {
  getWslHookReconciliationAction,
  installManagedHooksIntoWslRuntime,
  refreshWslRuntimeUserHooks
} from './codex-hook-wsl-runtime'

export type { CodexManagedHookInstallMaterial } from './codex-hook-definition'
export { getCodexManagedHookInstallMaterial } from './codex-hook-definition'
export { setSystemCodexHomeHookSweepSuppressed } from './codex-hook-legacy-cleanup'
export { CodexHookService }
export {
  createCodexWslRuntimeHookInstallPlan,
  type CodexWslRuntimeHookInstallPlan
} from './codex-wsl-hook-install-plan'

export const codexHookService = new CodexHookService()

export const _internals = {
  cleanupLegacySystemManagedHooks,
  getManagedScript,
  installManagedHooksIntoWslRuntime,
  refreshWslRuntimeUserHooks,
  removeStaleWslRuntimeManagedHookTrustEntries,
  getWslHookReconciliationAction
}
