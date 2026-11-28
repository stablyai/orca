import type { BrowserSessionProfile } from '../../../../shared/browser/workspaces/browser-workspace-types'
import { BrowserExtensionApiError } from '../api-runtime/browser-extension-namespace-registry'
import { browserExtensionSourceProfileId } from '../profile-sessions/browser-extension-route-profiles'
import { assertBrowserExtensionProfilePresent } from '../profile-sessions/browser-extension-profile-presence'

type BrowserExtensionTabTarget = {
  worktreeId: string | undefined
  profileId: string
  partition: string | undefined
  fallbackWorktreeId: string | undefined
}

/**
 * Where a tab an extension opens goes, so it lands in the extension's own session. A local
 * profile's opens in that profile; an SSH page's instance opens beside its pages, in their SSH
 * workspace, whose route gives the tab that session. This-device pages have no local workspace.
 */
export function browserExtensionTabTarget(
  profile: BrowserSessionProfile,
  placement: { worktreeId?: string },
  recentWorktreeId: (profileId: string) => string | undefined
): BrowserExtensionTabTarget {
  // After the window wait: a profile deleted meanwhile would mount the tab in a retired partition.
  assertBrowserExtensionProfilePresent(profile.id)
  const sourceProfileId = browserExtensionSourceProfileId(profile.id)
  const fallbackWorktreeId = recentWorktreeId(profile.id)
  if (sourceProfileId === profile.id) {
    return {
      worktreeId: placement.worktreeId,
      profileId: profile.id,
      partition: profile.partition,
      fallbackWorktreeId
    }
  }
  // An agent's placement names its own page's workspace; otherwise the one this session's pages are in.
  const worktreeId = placement.worktreeId ?? fallbackWorktreeId
  if (!worktreeId) {
    throw new BrowserExtensionApiError("Extensions on This-device pages can't open tabs yet")
  }
  return { worktreeId, profileId: sourceProfileId, partition: undefined, fallbackWorktreeId }
}
