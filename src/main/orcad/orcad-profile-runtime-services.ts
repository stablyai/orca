import { getAppEnvironment } from '../../shared/app-environment'
import type { Store } from '../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { OrcadFeatureReadiness } from '../runtime/rpc/startup/orcad-readiness'
import type { OrcadRuntimeCleanup } from './orcad-runtime-lifetime'

export async function installOrcadProfileRuntimeServices({
  userDataPath,
  store,
  runtime,
  featureReadiness,
  registerCleanup
}: {
  userDataPath: string
  store: Pick<Store, 'getSettings' | 'getRepos' | 'getAllWorktreeMeta' | 'onWorktreeMetaWritten'>
  runtime: OrcaRuntimeService
  featureReadiness: Pick<OrcadFeatureReadiness, 'open'>
  registerCleanup: (cleanup: OrcadRuntimeCleanup) => void
}) {
  const { startOrcadUsageHistory } = await import('./orcad-usage-history')
  startOrcadUsageHistory(userDataPath, store, runtime.usageHistory, registerCleanup)

  // Restore the profile's account selection before admitting launches.
  const { restoreOrcadHostAccountLaunchEnv } = await import('./orcad-host-account-launch-env-store')
  restoreOrcadHostAccountLaunchEnv(runtime, userDataPath)
  featureReadiness.open('accounts')

  const { installOrcadSessionSearchService } = await import('./orcad-session-search')
  const sessionSearch = await installOrcadSessionSearchService({
    userDataPath,
    getSettings: () => store.getSettings()
  })
  getAppEnvironment().onWillQuit(() => sessionSearch?.dispose())
  featureReadiness.open('sessionSearch')
  return sessionSearch
}
