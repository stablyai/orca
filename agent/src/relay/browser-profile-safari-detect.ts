// agent/src/relay/browser-profile-safari-detect.ts
// Safari detection, split out of browser-profile-detect.ts. Ported from
// desktop/src/main/browser/browser-cookie-import.ts's detectSafari — same
// detection logic, run against the dev-server host this agent process
// itself runs on.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DetectedBrowser } from './browser-profile-types'

// Why Safari keeps desktop's cookies-file-existence check (unlike Chromium/
// Firefox): Safari has no separate "is it installed" signal analogous to a
// profile-metadata directory — the binarycookies file's existence IS the
// only detection signal available, on macOS only.
export function detectSafariOnHost(): DetectedBrowser | null {
  if (process.platform !== 'darwin') {
    return null
  }
  const home = process.env.HOME ?? ''
  const candidates = [
    join(home, 'Library', 'Cookies', 'Cookies.binarycookies'),
    join(
      home,
      'Library',
      'Containers',
      'com.apple.Safari',
      'Data',
      'Library',
      'Cookies',
      'Cookies.binarycookies'
    )
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return {
        family: 'safari',
        label: 'Safari',
        profiles: [{ name: 'Default', directory: 'Default' }],
        selectedProfile: 'Default'
      }
    }
  }
  return null
}
