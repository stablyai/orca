// agent/src/relay/browser-profile-detect.ts
// Cross-platform installed-browser detection, ported from
// desktop/src/main/browser/browser-cookie-import.ts's
// detectInstalledBrowsers/browserRootPath/discoverProfiles/
// discoverFirefoxProfiles/detectFirefox/detectSafari — same detection logic, run against
// the dev-server host this agent process itself runs on, not the
// operator's own desktop.
//
// TASK-025 status (specs/backend-go/bugs/missing-v3/tasks/TASK-025-*.md):
// this file also carries the cookie-decryption *primitives* ported from
// browser-cookie-import.ts (OS key derivation, HMAC-prefix handling,
// Chromium/Windows-GCM decrypt, cookie validation/normalization, Safari's
// binary cookie parser, and the agent-browser `cookies set` arg builder) —
// all pure functions or thin execFileSync shell-outs, each independently
// unit-tested (see browser-profile-detect.test.ts) without requiring a real
// installed browser, live OS keychain, or live `agent-browser` process.
//
// Deliberately NOT ported/wired in this pass (left for a follow-up task,
// not silently assumed done): the end-to-end orchestration
// (`importCookiesFromInstalledBrowser`) that reads a REAL browser's cookie
// store (Chromium SQLite snapshot-and-read incl. its WAL-safety dance,
// Firefox's cookies.sqlite read, live integrity-cookie skip list) and
// writes each decrypted cookie into an agent-browser session via
// `cookies set`, plus the `browser.profileImportFromBrowser` RPC
// handler/dispatch case that would call it. Reasons, per this task's own
// documented risk flag:
//   1. That orchestration is real, security-sensitive, host-side cookie
//      exfiltration machinery that cannot be verified against a real
//      installed Chrome/Firefox/Safari, a real macOS Keychain, real
//      Windows DPAPI, or the real `agent-browser cookies set` CLI in this
//      sandbox — only mocked. Shipping it unverified risks silently
//      corrupting or leaking real session cookies on a shared dev-server
//      host.
//   2. The wire-args question this task's own doc flags as unresolved
//      (`channels_browser_profiles.go`'s relay is devServerId-only, no
//      worktree field — confirmed by reading it fresh — so
//      `browser.profileImportFromBrowser`'s "which agent-browser session
//      receives the cookies" needs either the DEFAULT_BROWSER_PROFILE_SESSION
//      fallback TASK-023 defines, or a wscompat/frontend change to resolve
//      profileId server-side; that cross-cutting change is outside this
//      file's agent-only scope) is real and still open.
// A future pass wiring the full pipeline can build directly on the
// primitives below rather than re-deriving them.
//
// Split across several domain files to stay under oxlint's max-lines budget
// (same pattern as this directory's agent-rpc-dispatch-*.ts split): browser
// detection lives in browser-profile-chromium-detect.ts/
// browser-profile-firefox-detect.ts/browser-profile-safari-detect.ts, and
// the TASK-025 cookie primitives live in browser-cookie-normalize.ts/
// browser-cookie-crypto.ts/browser-cookie-decrypt.ts/
// browser-cookie-safari-binary-parser.ts/browser-cookie-agent-args.ts. This
// file keeps the orchestrator (detectInstalledBrowsersOnHost) and
// re-exports every symbol so existing imports of './browser-profile-detect'
// keep working unchanged.

import {
  CHROMIUM_BROWSERS,
  browserRootPath,
  discoverProfiles
} from './browser-profile-chromium-detect'
import { detectFirefoxOnHost } from './browser-profile-firefox-detect'
import { detectSafariOnHost } from './browser-profile-safari-detect'
import type { DetectedBrowser } from './browser-profile-types'

export type { BrowserProfile, DetectedBrowser } from './browser-profile-types'

export function detectInstalledBrowsersOnHost(): DetectedBrowser[] {
  const detected: DetectedBrowser[] = []
  for (const browser of CHROMIUM_BROWSERS) {
    const root = browserRootPath(browser)
    if (!root) {
      continue
    }
    const profiles = discoverProfiles(root)
    if (profiles.length > 0) {
      detected.push({
        family: browser.family,
        label: browser.label,
        profiles,
        selectedProfile: profiles[0].directory
      })
    }
  }

  const firefox = detectFirefoxOnHost()
  if (firefox) {
    detected.push(firefox)
  }

  const safari = detectSafariOnHost()
  if (safari) {
    detected.push(safari)
  }

  return detected
}

export {
  chromiumTimestampToUnix,
  firefoxSameSite,
  normalizeSameSite,
  deriveUrl,
  validateCookieEntry,
  type ValidatedCookie
} from './browser-cookie-normalize'

export { getEncryptionKey, type EncryptionKeyResult } from './browser-cookie-crypto'

export {
  hasHmacPrefix,
  stripHmac,
  decryptAes256Gcm,
  decryptCookieValueRaw
} from './browser-cookie-decrypt'

export { decodeSafariBinaryCookies } from './browser-cookie-safari-binary-parser'

export { buildAgentBrowserCookieSetArgs } from './browser-cookie-agent-args'
