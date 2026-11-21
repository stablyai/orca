/** Desktop state a WSL host is given: the selected agent accounts, chat naming, and the permission choice at Add. */
import type { WslHostAddResult } from '../../../shared/remote-runtime/wsl-hosts/wsl-host-types'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import type { Store } from '../../persistence/loading-store/store'
import { pushWslOrcadHostAccountEnv } from '../../wsl/orcad/wsl-orcad-host-account-push'
import { pushWslOrcadHostChatAutoName } from '../../wsl/orcad/wsl-orcad-host-chat-naming-push'
import { seedWslHostAgentPermission } from '../../wsl/host-lifecycle/wsl-host-permission-seed'
import { wslOrcadHostSupports } from '../../wsl/orcad/wsl-orcad-host-environments'
import { callRuntimeEnvironment } from '../runtime-environments/requests/runtime-environment-transport-routing'

// Add waits for the seed, so a slow host must not hold the dialog for the default RPC timeout.
export const SEED_DEADLINE_MS = 5_000

/** Best-effort: a failed seed leaves the host at its own default, which Settings can still change. */
export async function seedHostPermission(
  userDataPath: string,
  local: Pick<GlobalSettings, 'agentPermissionDefault' | 'agentPermissionOverrides'>,
  environmentId: string
): Promise<void> {
  const call = (method: string, params: unknown) =>
    callRuntimeEnvironment(userDataPath, environmentId, method, params, SEED_DEADLINE_MS)
  await seedWslHostAgentPermission({
    local,
    call,
    hostSupports: (capability) =>
      wslOrcadHostSupports(environmentId, capability, () => call('status.get', undefined))
  }).catch((error) => {
    console.warn(`[wsl-hosts] Could not copy agent permissions to ${environmentId}:`, error)
  })
}

/**
 * Add, then the permission seed: awaited so a worker started right after Add launches with the copied
 * choice, but bounded by one deadline and never able to fail an Add that succeeded.
 */
export async function addWslHostThenSeedPermission(
  add: () => Promise<WslHostAddResult>,
  seed: (environmentId: string) => Promise<void>,
  deadlineMs = SEED_DEADLINE_MS
): Promise<WslHostAddResult> {
  const result = await add()
  if (!result.ok) {
    return result
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.warn(
        `[wsl-hosts] Gave up waiting to copy agent permissions to ${result.environmentId}.`
      )
      resolve()
    }, deadlineMs)
  })
  // A seed that throws before returning a promise must not fail the Add either.
  const seeded = Promise.resolve()
    .then(() => seed(result.environmentId))
    .catch(() => {})
  await Promise.race([seeded, deadline])
  clearTimeout(timer)
  return result
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

export function pushHostChatAutoName(
  getUserDataPath: () => string,
  environmentId: string,
  store: Pick<Store, 'getSettings'>
): void {
  const call = (method: string, params: unknown) =>
    callRuntimeEnvironment(getUserDataPath(), environmentId, method, params)
  void pushWslOrcadHostChatAutoName(
    {
      environmentId,
      call,
      hostSupports: (capability) =>
        wslOrcadHostSupports(environmentId, capability, () => call('status.get', undefined))
    },
    () => store.getSettings().nativeChatAutoName !== false
  ).catch((error) => {
    console.warn(`[wsl-hosts] Could not copy chat naming to ${environmentId}:`, error)
  })
}
