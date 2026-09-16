import {
  resolveAiVaultSearchSettings,
  sameAiVaultSearchSettings
} from '../../shared/ai-vault-search-settings'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { updateSessionSearchInService } from '../ai-vault/session-scanner-service-spawn'
import { createChildSessionSearchService } from './session-search-child-service'
import { installSessionSearchPolicySource } from './session-search-policy'
import { setSessionSearchService } from './session-search-service-registry'
import {
  installSessionSearchDataRoot,
  sessionSearchServiceInit
} from './session-search-service-init'
import { sessionSearchSqliteAvailable } from './session-search-sqlite-support'
let installed = false

/**
 * The desktop's one wiring point: search answers from the scanner child, and the
 * child's consent comes from the settings store.
 *
 * Registered whether or not the setting is on, because "off" is an answer this
 * host can give (`unavailable/disabled`) and `no-service` is not — that reason
 * means nothing here owns an index, which stops being true the moment this runs.
 */
export function installChildSessionSearchService(args: {
  dataRoot: string
  getSettings: () => Pick<GlobalSettings, 'aiVaultSearch'>
}): { dispose(): void } | null {
  if (!sessionSearchSqliteAvailable()) {
    return null
  }
  installed = true
  installSessionSearchDataRoot(args.dataRoot)
  installSessionSearchPolicySource(args.getSettings)
  setSessionSearchService(createChildSessionSearchService())
  pushSessionSearchPolicy()
  return {
    dispose: () => {
      installed = false
    }
  }
}

/**
 * Reconciles a settings write. An unchanged policy is not forwarded, so re-saving
 * the same value never restarts a running index.
 */
export function applySessionSearchSettingsChange(
  before: Pick<GlobalSettings, 'aiVaultSearch'>,
  after: Pick<GlobalSettings, 'aiVaultSearch'>
): void {
  if (
    sameAiVaultSearchSettings(
      resolveAiVaultSearchSettings(before),
      resolveAiVaultSearchSettings(after)
    )
  ) {
    return
  }
  if (installed) {
    pushSessionSearchPolicy()
  }
}

function pushSessionSearchPolicy(): void {
  const init = sessionSearchServiceInit()
  if (init) {
    updateSessionSearchInService(init)
  }
}
