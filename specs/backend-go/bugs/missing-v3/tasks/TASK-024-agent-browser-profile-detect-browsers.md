# TASK-024: Port cross-platform installed-browser detection to the Dev Server Agent for `browser.profileDetectBrowsers`

**From Solution:** SOL-009
**Priority:** P1 — real, bounded port (detection only, no decryption); independent of TASK-023; TASK-025 (`profileImportFromBrowser`) builds on the module this task creates
**Service:** `agent/` (Dev Server Agent) — no backend-go changes
**File:** `agent/src/relay/browser-profile-detect.ts` (new), `agent/src/relay/browser-handler.ts`, `agent/src/relay/agent-rpc-dispatch-browser.ts`, `agent/src/relay/browser-profile-detect.test.ts` (new), `agent/src/relay/agent-rpc-dispatch-browser.test.ts`
**Depends on:** none (parallel with TASK-023); TASK-025 depends on this task, since it extends the same new module
**Status:** `[x]` DONE — ported detection (Chromium table/root-resolution/Local-State parsing, Firefox profiles.ini-dir scan, Safari binarycookies check) into the new `agent/src/relay/browser-profile-detect.ts`, plus the `browser.profileDetectBrowsers` handler/dispatch case. **Deviation from sketch:** the task's premise that `desktop/src/main/browser/browser-cookie-import.test.ts` has cases to port for "missing root directory / malformed Local State / traversal directory names" doesn't hold — that file's own `detectInstalledBrowsers` describe block is 2 real-filesystem smoke tests with no per-OS mocking harness, and `browserRootPath`/`discoverProfiles`/`isSafeBrowserProfileDirectory` aren't exported there to test directly. Wrote a fresh `browser-profile-detect.test.ts` (8 cases) mocking `node:fs` + `process.platform`/`env` directly against this module's own exports instead. Also extended Firefox's detection to not require a `cookies.sqlite` file (matching the same "detect purely on presence, not decryptability" deviation TASK-024's own doc already called out for Chromium); kept Safari's cookies-file-existence check as the sole detection signal since Safari has no separate profile-metadata directory to check instead. `npx vitest run` (39/39 pass across all 3 browser-profile test files) and `npx tsc --noEmit` (zero errors in any touched file, including the new test file after fixing an initial `Buffer`-vs-`string` mock-typing mismatch) both clean.

---

## Context

`agent/src/relay` and `agent/src` have no browser-cookie-jar or
installed-browser-detection concept today (confirmed by SOL-009's own
grep pass — every "profile" hit is unrelated shell-profile/OAuth-claims/
telemetry code). `agent-browser`'s CLI has no `detect`/`browsers`
subcommand either (its closest-sounding feature, `auth save/login/list/
show/delete`, is a saved-credential autofill vault, an unrelated
concept) — so unlike TASK-023, there is no existing command to shell out
to. `desktop/src/main/browser/browser-cookie-import.ts`'s
`detectInstalledBrowsers()` already implements this exact enumeration
(Chrome/Edge/Arc/Brave/Comet/Helium via `browserRootPath`/
`discoverProfiles`, Firefox via `discoverFirefoxProfiles`, Safari via
`detectSafari`) for the Electron-local case; this task ports the
detection half only (no decryption) to run against the dev-server host
the agent process itself runs on.

## Changes to make

### 1. `agent/src/relay/browser-profile-detect.ts` (new file)

Port `browserRootPath`, `isSafeBrowserProfileDirectory`, `discoverProfiles`,
`firefoxProfilesRoot`, `discoverFirefoxProfiles`, `detectFirefox`,
`detectSafari`, and `detectInstalledBrowsers` from
`desktop/src/main/browser/browser-cookie-import.ts:174-393`, adapted to
drop everything decryption-specific (this task's function does not need
`keychainService`/`keychainAccount`/`cookiesPath` resolution — TASK-025
adds those back when it extends this file for the import path). Keep the
`CHROMIUM_BROWSERS` table (`browser-cookie-import.ts:118-167`) verbatim —
it's the source of truth for which browsers/platforms are supported and
must not drift between the desktop and agent copies.

```ts
// agent/src/relay/browser-profile-detect.ts
// Cross-platform installed-browser detection, ported from
// desktop/src/main/browser/browser-cookie-import.ts's
// detectInstalledBrowsers/browserRootPath/discoverProfiles/
// discoverFirefoxProfiles/detectSafari — same detection logic, run against
// the dev-server host this agent process itself runs on, not the
// operator's own desktop. Decryption (TASK-025,
// importCookiesFromInstalledBrowser) extends this file separately; this
// module's exports here are detection-only.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export type BrowserProfile = { name: string; directory: string }

export type DetectedBrowser = {
  family: string // BrowserSessionProfileSource['browserFamily'] on the frontend side
  label: string
  profiles: BrowserProfile[]
  selectedProfile: string
}

type ChromiumBrowserDef = {
  family: string
  label: string
  macRoot?: string
  winRoot?: string
  linuxRoot?: string
}

// Verbatim copy of desktop/src/main/browser/browser-cookie-import.ts's
// CHROMIUM_BROWSERS table (keychainService/keychainAccount fields dropped
// — decryption-only, added back by TASK-025's extension of this file).
const CHROMIUM_BROWSERS: ChromiumBrowserDef[] = [
  { family: 'chrome', label: 'Google Chrome', macRoot: 'Google/Chrome', winRoot: 'Google/Chrome/User Data', linuxRoot: 'google-chrome' },
  { family: 'edge', label: 'Microsoft Edge', macRoot: 'Microsoft Edge', winRoot: 'Microsoft/Edge/User Data', linuxRoot: 'microsoft-edge' },
  { family: 'arc', label: 'Arc', macRoot: 'Arc/User Data' },
  { family: 'chromium', label: 'Brave', macRoot: 'BraveSoftware/Brave-Browser', winRoot: 'BraveSoftware/Brave-Browser/User Data', linuxRoot: 'BraveSoftware/Brave-Browser' },
  { family: 'comet', label: 'Comet', macRoot: 'Comet', winRoot: 'Comet/User Data' },
  { family: 'helium', label: 'Helium', macRoot: 'net.imput.helium' }
]

function browserRootPath(def: ChromiumBrowserDef): string | null {
  if (process.platform === 'darwin') {
    if (!def.macRoot) return null
    return join(process.env.HOME ?? '', 'Library', 'Application Support', def.macRoot)
  }
  if (process.platform === 'win32') {
    if (!def.winRoot) return null
    const localAppData = process.env.LOCALAPPDATA ?? ''
    return localAppData ? join(localAppData, def.winRoot) : null
  }
  if (!def.linuxRoot) return null
  const configHome = process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? '', '.config')
  return join(configHome, def.linuxRoot)
}

function isSafeBrowserProfileDirectory(directory: string): boolean {
  return (
    directory.length > 0 &&
    directory !== '.' &&
    !directory.includes('\0') &&
    !directory.includes('/') &&
    !directory.includes('\\') &&
    !directory.includes('..')
  )
}

function discoverProfiles(browserRoot: string): BrowserProfile[] {
  try {
    const localStatePath = join(browserRoot, 'Local State')
    if (!existsSync(localStatePath)) {
      return [{ name: 'Default', directory: 'Default' }]
    }
    const localState = JSON.parse(readFileSync(localStatePath, 'utf-8'))
    const infoCache = localState?.profile?.info_cache
    if (!infoCache || typeof infoCache !== 'object') {
      return [{ name: 'Default', directory: 'Default' }]
    }
    const profiles: BrowserProfile[] = []
    for (const [dir, info] of Object.entries(infoCache)) {
      if (!isSafeBrowserProfileDirectory(dir)) continue
      profiles.push({ name: (info as { name?: string })?.name ?? dir, directory: dir })
    }
    return profiles.length > 0 ? profiles : [{ name: 'Default', directory: 'Default' }]
  } catch {
    return [{ name: 'Default', directory: 'Default' }]
  }
}

function firefoxProfilesRoot(): string | null {
  if (process.platform === 'darwin') {
    return join(process.env.HOME ?? '', 'Library', 'Application Support', 'Firefox', 'Profiles')
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? ''
    return appData ? join(appData, 'Mozilla', 'Firefox', 'Profiles') : null
  }
  return join(process.env.HOME ?? '', '.mozilla', 'firefox')
}

// Port desktop's discoverFirefoxProfiles/detectFirefox/detectSafari
// verbatim (browser-cookie-import.ts:258-354) minus their
// cookiesPath/keychain fields — read the real current implementations at
// that file/line range before porting, don't re-derive from this sketch,
// since profiles.ini parsing (Firefox) and the plist-based Safari
// detection have real edge cases already handled there (missing profiles
// root, malformed profiles.ini, absent Safari Cookies.binarycookies file).

export function detectInstalledBrowsersOnHost(): DetectedBrowser[] {
  const detected: DetectedBrowser[] = []
  for (const browser of CHROMIUM_BROWSERS) {
    const root = browserRootPath(browser)
    if (!root) continue
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
  // + Firefox/Safari, ported the same way (see note above)
  return detected
}
```

**Deviation from desktop's `detectInstalledBrowsers`, deliberate:** the
desktop version only includes a browser if a real `cookiesPath` resolves
for at least one profile (`browser-cookie-import.ts:365-375`), because it
needs a decryptable cookie store to be useful at all. This task's
detect-only function has no cookie-decryption concern yet, so it reports
a Chromium-family browser as "detected" whenever its profile-metadata
directory exists, even if a given profile's `Cookies` DB is missing —
TASK-025's `importCookiesFromInstalledBrowser` does the real
cookies-file-exists check at import time and returns a clear per-profile
failure reason if the DB is absent, matching desktop's
`importCookiesFromBrowser`'s own `if (!existsSync(browser.cookiesPath))`
guard (`browser-cookie-import.ts:1451-1454`). Flag this explicitly in code
review — if it produces a worse UX (a browser listed but every profile
import fails), tighten `detectInstalledBrowsersOnHost` to pre-check
`Cookies`/`cookies.sqlite` existence the same way desktop does, before
shipping.

### 2. `browser-handler.ts` — new handler

Following the try/catch + `makeSuccess`/`makeFailure` shape used for ops
that don't shell out to `agent-browser` directly (not
`dispatchBrowserCommand`, which requires a worktree param this call
doesn't have):

```ts
// ─── browser.profileDetectBrowsers ──────────────────────────────────────────

export async function handleBrowserProfileDetectBrowsers(
  id: JsonRpcId,
  _params: Record<string, unknown>,
  log: AgentLogger
): Promise<JsonRpcResponse> {
  try {
    const { detectInstalledBrowsersOnHost } = await import('./browser-profile-detect')
    return makeSuccess(id, { browsers: detectInstalledBrowsersOnHost() }) // matches BrowserDetectProfilesResult.browsers
                                                                           // (frontend/src/shared/runtime-types.ts:870-879)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error(`browser.profileDetectBrowsers failed: ${message}`)
    return makeFailure(id, message)
  }
}
```

### 3. `agent-rpc-dispatch-browser.ts` — new case

```ts
case 'browser.profileDetectBrowsers': {
  try {
    const { handleBrowserProfileDetectBrowsers } = await import('./browser-handler')
    return (await handleBrowserProfileDetectBrowsers(rpc.id, rpc.params ?? {}, log)) as JsonRpcResponse
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return makeError(rpc.id, AgentErrorCode.ServerError, `browser.profileDetectBrowsers unavailable: ${msg}`)
  }
}
```

### 4. A product question this surfaces, not resolved here

`detectInstalledBrowsersOnHost()` enumerates browsers installed **on the
dev-server host**, not the user's own machine — on a headless Linux VM,
that's typically nothing. Flagged by SOL-009 as a UX question (should the
picker UI say "browsers found on the dev server"?) for whoever owns the
frontend picker, not something this agent-side task should silently
paper over or block on.

## Verify

```bash
cd agent
npx vitest run src/relay/browser-profile-detect.test.ts src/relay/agent-rpc-dispatch-browser.test.ts
npx tsc --noEmit
```

`browser-profile-detect.test.ts` (new): port the detection-relevant cases
from `desktop/src/main/browser/browser-cookie-import.test.ts` (missing
root directory, malformed `Local State` JSON falling back to `Default`,
`isSafeBrowserProfileDirectory` rejecting traversal directory names),
adapted to this module's exports and mocking `process.platform`/
`process.env` per-OS the same way the desktop test suite does — check
that file's actual mocking setup before writing this one, don't guess the
harness.
