import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import { isPerfPrereleaseAppVersion } from '../../../shared/app-lifecycle/identity/app-version'
import { getAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import { getVersionChannel } from '../../../shared/updater/release-channel'
import {
  readCachedReleaseAssetPolicyAsync,
  ReleaseAssetPolicyLiveUpdater,
  type ReleaseAssetPolicySpec
} from '../../remote-policies/release-asset-policy-live-update'
import { getMainHttpClient } from '../../network/http-client'

const emergencyUpdatePolicySchema = lazyZodSchema(() =>
  z.object({
    revision: z.number().int().positive(),
    minimumVersion: z
      .string()
      .max(64)
      .refine((version) => {
        const channel = getVersionChannel(version)
        return channel === 'stable' || (channel === 'rc' && !isPerfPrereleaseAppVersion(version))
      })
      .nullable()
  })
)

type EmergencyUpdatePolicy = z.infer<typeof emergencyUpdatePolicySchema>

const EMERGENCY_UPDATE_POLICY: ReleaseAssetPolicySpec<EmergencyUpdatePolicy> = {
  name: 'emergency-update-policy',
  releaseTag: 'orca-update-policy',
  assetName: 'emergency-update-policy.json',
  maxBytes: 4096,
  parse: (text) => {
    try {
      const parsed = emergencyUpdatePolicySchema.safeParse(JSON.parse(text))
      return parsed.success
        ? { ok: true, policy: parsed.data }
        : { ok: false, error: 'invalid emergency update policy' }
    } catch {
      return { ok: false, error: 'invalid JSON' }
    }
  }
}

let policy: EmergencyUpdatePolicy | null = null

export function getEmergencyUpdateFloor(): string | null {
  return policy?.minimumVersion ?? null
}

export function watchEmergencyUpdateFloor(onChanged: () => void): (governed: boolean) => void {
  const environment = getAppEnvironment()
  const userDataPath = environment.getPath('userData')
  const appVersion = environment.getVersion()
  let active = false
  const apply = (next: EmergencyUpdatePolicy | null): void => {
    if (!active || !next || (policy && next.revision <= policy.revision)) {
      return
    }
    policy = next
    onChanged()
  }
  const updater = new ReleaseAssetPolicyLiveUpdater(EMERGENCY_UPDATE_POLICY, {
    userDataPath,
    appVersion,
    isPackaged: environment.isPackaged(),
    fetch: (url, init) => getMainHttpClient().fetch(url, init),
    onFetched: apply
  })
  return (governed) => {
    if (governed === active) {
      return
    }
    active = governed
    if (active) {
      void readCachedReleaseAssetPolicyAsync(
        EMERGENCY_UPDATE_POLICY,
        userDataPath,
        appVersion
      ).then(apply)
      void updater.start()
    } else {
      updater.stop()
    }
  }
}
