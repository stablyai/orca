import { forgetBrowserExtensionActionProfile } from '../actions/browser-extension-action-registry'
import { getBrowserExtensionDnrStore } from '../declarative-net-request/session/browser-extension-dnr-store'
import { dropBrowserExtensionIdleState } from '../profile-sessions/browser-extension-idle-kept-state'
import { getBrowserExtensionProfileStateStore } from './browser-extension-profile-state-store'
import { getBrowserExtensionSyncStorageStore } from './browser-extension-sync-storage-store'

/** What Orca keeps for one extension profile outside its session: kept and action state, grants, sync storage, dynamic rules. */
export async function forgetBrowserExtensionProfileData(profileId: string): Promise<void> {
  dropBrowserExtensionIdleState({ profileId, forgetProfile: true })
  forgetBrowserExtensionActionProfile(profileId)
  getBrowserExtensionProfileStateStore().forgetProfile(profileId)
  await Promise.all([
    getBrowserExtensionSyncStorageStore().forgetProfile(profileId),
    getBrowserExtensionDnrStore().forgetProfile(profileId)
  ])
}
