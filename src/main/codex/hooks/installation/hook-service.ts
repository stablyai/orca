import { CodexHookService } from './codex-hook-service-implementation'
import { cleanupLegacySystemManagedHooks } from '../reconciliation/codex-hook-legacy-cleanup'
import { getManagedScript } from '../definitions/codex-hook-script'
import { removeStaleWslRuntimeManagedHookTrustEntries } from '../../trust/hooks/codex-hook-trust-cleanup'
import {
  getWslHookReconciliationAction,
  installManagedHooksIntoWslRuntime,
  refreshWslRuntimeUserHooks
} from './codex-hook-wsl-runtime'

export const codexHookService = new CodexHookService()

export const _internals = {
  cleanupLegacySystemManagedHooks,
  getManagedScript,
  installManagedHooksIntoWslRuntime,
  refreshWslRuntimeUserHooks,
  removeStaleWslRuntimeManagedHookTrustEntries,
  getWslHookReconciliationAction
}
