/** Push selected distro account homes on connect/selection changes so host-initiated CLI, automation, chat and text-generation launches use the same account. */
import type { HostAccountLaunchEnv } from '../../../shared/agent-launch/startup/host-account-launch-env'
import { HOST_ACCOUNT_LAUNCH_ENV_RUNTIME_CAPABILITY } from '../../../shared/remote-runtime/protocol/orcad-runtime-capabilities'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import type { RuntimeRpcResponse } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import {
  distroTarget,
  getWslOrcadAccountEnvDependencies,
  prepareWslOrcadAccountEnv,
  type WslOrcadAccountEnvDependencies
} from './wsl-orcad-account-env'
import type { WslOrcadHostCapabilityVerdict } from './wsl-orcad-host-environments'
import {
  createWslOrcadHostPushQueue,
  pushToWslOrcadHostWithRetry,
  WSL_HOST_PUSH_RETRY_DELAYS_MS
} from './wsl-orcad-host-push-retry'

export type WslOrcadHostAccountPush = {
  environmentId: string
  distro: string
  hostSupports: (capability: string) => Promise<WslOrcadHostCapabilityVerdict>
  call: (method: string, params: unknown) => Promise<RuntimeRpcResponse<unknown>>
}

/** The settings whose change can move a distro's selected Claude or Codex account. */
export const WSL_HOST_ACCOUNT_SETTING_KEYS = [
  'activeClaudeManagedAccountId',
  'activeClaudeManagedAccountIdsByRuntime',
  'claudeManagedAccounts',
  'activeCodexManagedAccountId',
  'activeCodexManagedAccountIdsByRuntime',
  'codexManagedAccounts'
] as const satisfies readonly (keyof GlobalSettings)[]

export function changesWslHostAccounts(updates: Partial<GlobalSettings>): boolean {
  return WSL_HOST_ACCOUNT_SETTING_KEYS.some((key) => key in updates)
}

export async function prepareWslOrcadHostLaunchEnv(
  distro: string,
  dependencies: WslOrcadAccountEnvDependencies
): Promise<HostAccountLaunchEnv> {
  return {
    wslDistro: distro,
    claude: await prepareWslOrcadAccountEnv(distro, 'claude', dependencies),
    terminal: await prepareWslOrcadAccountEnv(distro, null, dependencies)
  }
}

async function pushOnce(
  push: WslOrcadHostAccountPush,
  dependencies: WslOrcadAccountEnvDependencies
): Promise<void> {
  const verdict = await push.hostSupports(HOST_ACCOUNT_LAUNCH_ENV_RUNTIME_CAPABILITY)
  if (verdict === 'unknown') {
    // Unknown capabilities are not proof of an old host; fail so the push retries.
    throw new Error('The host did not report its capabilities.')
  }
  if (verdict === 'unsupported') {
    if (dependencies.managedAccountSelected(distroTarget(push.distro))) {
      dependencies.accountNotApplied(push.distro)
    }
    return
  }
  const launchEnv = await prepareWslOrcadHostLaunchEnv(push.distro, dependencies)
  const response = await push.call('accounts.setHostLaunchEnv', launchEnv)
  if (!response.ok) {
    throw new Error(response.error.message)
  }
}

const queue = createWslOrcadHostPushQueue()

/** Serialized per host, so an older selection can never land after a newer one. */
export function pushWslOrcadHostAccountEnv(
  push: WslOrcadHostAccountPush,
  dependencies: WslOrcadAccountEnvDependencies | null = getWslOrcadAccountEnvDependencies(),
  retryDelaysMs: readonly number[] = WSL_HOST_PUSH_RETRY_DELAYS_MS
): Promise<void> {
  if (!dependencies) {
    return Promise.resolve()
  }
  return pushToWslOrcadHostWithRetry(
    queue,
    push.environmentId,
    () => pushOnce(push, dependencies),
    (error) => {
      // Retain the last host account on failure; clearing it would launch under another account.
      console.warn(`[wsl-hosts] Could not give ${push.distro} its selected accounts:`, error)
    },
    retryDelaysMs
  )
}
