import { BrowserError } from '../../../browser/browser-error'
import { browserSessionRegistry } from '../../../browser/sessions/profiles/browser-session-registry'
import { detectInstalledBrowsers } from '../../../browser/cookies/sources/browser-cookie-detection'
import type {
  BrowserDetectProfilesResult,
  BrowserProfileCreateResult,
  BrowserProfileRenameResult
} from '../../../../shared/browser/runtime/runtime-browser-contracts'
import type {
  BrowserSessionProfile,
  BrowserSessionProfileScope
} from '../../../../shared/browser/workspaces/browser-workspace-types'

export function requireBrowserProfile(profileId: string): BrowserSessionProfile {
  const profile =
    browserSessionRegistry.getProfile(profileId) ??
    (profileId === 'default' ? browserSessionRegistry.getDefaultProfile() : null)
  if (!profile) {
    throw new BrowserError('invalid_argument', `Browser profile ${profileId} was not found`)
  }
  return profile
}

export async function createRuntimeBrowserProfile(
  scope: BrowserSessionProfileScope,
  label: string
): Promise<BrowserProfileCreateResult> {
  return { profile: await browserSessionRegistry.createProfile(scope, label) }
}

export async function renameRuntimeBrowserProfile(
  profileId: string,
  label: string
): Promise<BrowserProfileRenameResult> {
  const trimmed = label.trim()
  if (!trimmed) {
    throw new BrowserError('invalid_argument', 'A browser profile label is required')
  }
  const profile = browserSessionRegistry.renameProfile(profileId, trimmed)
  if (!profile) {
    throw new BrowserError('invalid_argument', `Browser profile ${profileId} was not found`)
  }
  return { profile }
}

export function detectRuntimeBrowserProfiles(): BrowserDetectProfilesResult {
  return {
    // Expose display metadata only; retain paths/keychain identifiers on the server.
    browsers: detectInstalledBrowsers().map((browser) => ({
      family: browser.family,
      label: browser.label,
      profiles: browser.profiles,
      selectedProfile: browser.selectedProfile
    }))
  }
}
