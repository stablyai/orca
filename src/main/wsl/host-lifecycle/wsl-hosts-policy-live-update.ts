import { getAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import { isWslHostsInternalGateOpen } from '../../../shared/remote-runtime/wsl-hosts/wsl-host-internal-gate'
import {
  parseWslHostsPolicy,
  WSL_HOSTS_POLICY_MAX_BYTES,
  type WslHostsPolicy
} from '../../../shared/remote-runtime/wsl-hosts/wsl-hosts-policy'
import { getMainHttpClient } from '../../network/http-client'
import {
  readCachedReleaseAssetPolicy,
  releaseAssetPolicyCacheFileName,
  releaseAssetPolicyChannelForAppVersion,
  ReleaseAssetPolicyLiveUpdater,
  type ReleaseAssetPolicyChannel,
  type ReleaseAssetPolicyLiveUpdateDeps,
  type ReleaseAssetPolicySpec
} from '../../remote-policies/release-asset-policy-live-update'
import { noteWslHostsLivePolicyBlock } from './wsl-host-gate'

export type WslHostsPolicyChannel = ReleaseAssetPolicyChannel

const WSL_HOSTS_POLICY: ReleaseAssetPolicySpec<WslHostsPolicy> = {
  name: 'wsl-hosts-policy',
  releaseTag: (channel) => `wsl-hosts-policy-${channel}`,
  assetName: 'wsl-hosts-policy.json',
  maxBytes: WSL_HOSTS_POLICY_MAX_BYTES,
  parse: parseWslHostsPolicy
}

export const wslHostsPolicyChannelForAppVersion = releaseAssetPolicyChannelForAppVersion

export function wslHostsPolicyCacheFileName(channel: WslHostsPolicyChannel): string {
  return releaseAssetPolicyCacheFileName(WSL_HOSTS_POLICY, channel)
}

/** The last policy a download cached, read synchronously so the startup gate can use it. */
export function readCachedWslHostsPolicy(
  userDataPath: string,
  appVersion: string
): WslHostsPolicy | null {
  return readCachedReleaseAssetPolicy(WSL_HOSTS_POLICY, userDataPath, appVersion)
}

export type WslHostsPolicyLiveUpdateDeps = Omit<
  ReleaseAssetPolicyLiveUpdateDeps<WslHostsPolicy>,
  'onFetched'
> & {
  /** The newest known policy blocks; new work stops this run, the rest waits for the next launch. */
  onBlock?: () => void
}

/**
 * Keeps the cached policy current; it applies on the next launch, never mid-run, so a flip cannot
 * pull a running host or an in-flight move out from under the user. Failures keep the cache.
 */
export class WslHostsPolicyLiveUpdater extends ReleaseAssetPolicyLiveUpdater<WslHostsPolicy> {
  constructor({ onBlock, ...deps }: WslHostsPolicyLiveUpdateDeps) {
    super(WSL_HOSTS_POLICY, {
      ...deps,
      onFetched: (policy) => {
        if (policy.wslHosts === 'block') {
          onBlock?.()
        }
      }
    })
  }
}

/** Fetches only where the launch environment opened the gate, even while a cached block closes it. */
export function startWslHostsPolicyLiveUpdates(): void {
  if (process.platform !== 'win32' || !isWslHostsInternalGateOpen(process.env)) {
    return
  }
  const environment = getAppEnvironment()
  const updater = new WslHostsPolicyLiveUpdater({
    userDataPath: environment.getPath('userData'),
    appVersion: environment.getVersion(),
    isPackaged: environment.isPackaged(),
    fetch: (url, init) => getMainHttpClient().fetch(url, init),
    onBlock: noteWslHostsLivePolicyBlock
  })
  void updater.start()
  environment.onWillQuit(() => updater.stop())
}
