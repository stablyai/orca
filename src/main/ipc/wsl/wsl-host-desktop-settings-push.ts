/** Desktop state a WSL host is given: the selected agent accounts, and the permission choice at Add. */
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import { pushWslOrcadHostAccountEnv } from '../../wsl/orcad/wsl-orcad-host-account-push'
import { seedWslHostAgentPermission } from '../../wsl/host-lifecycle/wsl-host-permission-seed'
import { wslOrcadHostSupports } from '../../wsl/orcad/wsl-orcad-host-environments'
import { callRuntimeEnvironment } from '../runtime-environments/requests/runtime-environment-transport-routing'

/** Best-effort: a failed seed leaves the host at its own default, which Settings can still change. */
export async function seedHostPermission(
  userDataPath: string,
  local: Pick<GlobalSettings, 'agentPermissionDefault' | 'agentPermissionOverrides'>,
  environmentId: string
): Promise<void> {
  const call = (method: string, params: unknown) =>
    callRuntimeEnvironment(userDataPath, environmentId, method, params)
  await seedWslHostAgentPermission({
    local: {
      agentPermissionDefault: local.agentPermissionDefault,
      agentPermissionOverrides: local.agentPermissionOverrides
    },
    call,
    hostSupports: (capability) =>
      wslOrcadHostSupports(environmentId, capability, () => call('status.get', undefined))
  }).catch((error) => {
    console.warn(`[wsl-hosts] Could not copy agent permissions to ${environmentId}:`, error)
  })
}

export function pushHostAccounts(
  getUserDataPath: () => string,
  environmentId: string,
  distro: string
): void {
  const call = (method: string, params: unknown) =>
    callRuntimeEnvironment(getUserDataPath(), environmentId, method, params)
  void pushWslOrcadHostAccountEnv({
    environmentId,
    distro,
    call,
    hostSupports: (capability) =>
      wslOrcadHostSupports(environmentId, capability, () => call('status.get', undefined))
  })
}
