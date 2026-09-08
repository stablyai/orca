// agent/src/relay/browser-profile-firefox-detect.ts
// Firefox profile detection, split out of browser-profile-detect.ts. Ported
// from desktop/src/main/browser/browser-cookie-import.ts's
// discoverFirefoxProfiles/detectFirefox — same detection logic, run against
// the dev-server host this agent process itself runs on.

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserProfile, DetectedBrowser } from './browser-profile-types'

function firefoxProfilesRoot(): string | null {
  if (process.platform === 'darwin') {
    const home = process.env.HOME ?? ''
    return join(home, 'Library', 'Application Support', 'Firefox', 'Profiles')
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? ''
    return appData ? join(appData, 'Mozilla', 'Firefox', 'Profiles') : null
  }
  const home = process.env.HOME ?? ''
  return join(home, '.mozilla', 'firefox')
}

function discoverFirefoxProfiles(): BrowserProfile[] {
  const profilesRoot = firefoxProfilesRoot()
  if (!profilesRoot) {
    return []
  }
  try {
    if (!existsSync(profilesRoot)) {
      return []
    }
    const entries = readdirSync(profilesRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
    // Why: Firefox profile dirs are named <random>.<name> (e.g. "abc123.default-release").
    // Prefer 'default-release' as it's the primary user profile on most installs.
    const sorted = entries.sort((a, b) => {
      if (a.includes('default-release')) {
        return -1
      }
      if (b.includes('default-release')) {
        return 1
      }
      if (a.includes('default')) {
        return -1
      }
      if (b.includes('default')) {
        return 1
      }
      return 0
    })
    return sorted.map((dir) => {
      const label = dir.includes('.') ? dir.split('.').slice(1).join('.') : dir
      return { name: label, directory: dir }
    })
  } catch {
    return []
  }
}

// Deviation from desktop's detectFirefox: desktop only reports Firefox
// "detected" once a profile's cookies.sqlite actually exists, because it
// needs a decryptable store to be useful at all. This detect-only function
// reports Firefox as installed whenever it finds at least one profile
// directory — see this file's header / TASK-024's task doc for why
// (decryption's own existence check, TASK-025, is the real gate at import
// time).
export function detectFirefoxOnHost(): DetectedBrowser | null {
  const profilesRoot = firefoxProfilesRoot()
  if (!profilesRoot) {
    return null
  }
  const profiles = discoverFirefoxProfiles()
  if (profiles.length === 0) {
    return null
  }
  return {
    family: 'firefox',
    label: 'Firefox',
    profiles,
    selectedProfile: profiles[0].directory
  }
}
