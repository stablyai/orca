# TASK-025: Port cookie decryption + import to the Dev Server Agent for `browser.profileImportFromBrowser`

**From Solution:** SOL-009
**Priority:** P2 — the largest, most security-sensitive task in this solution's breakdown; do after TASK-024 lands (extends the same new module and reuses its detection/profile-selection logic)
**Service:** `agent/` (Dev Server Agent) — no backend-go changes
**File:** `agent/src/relay/browser-profile-detect.ts` (extends TASK-024's file), `agent/src/relay/browser-handler.ts`, `agent/src/relay/agent-rpc-dispatch-browser.ts`, `agent/src/relay/browser-profile-detect.test.ts` (extends TASK-024's tests)
**Depends on:** TASK-024 (extends the same `browser-profile-detect.ts` module and its `DetectedBrowser`/profile-selection exports)
**Status:** `[partial]` — ported and unit-tested the decryption/validation **primitives** into `agent/src/relay/browser-profile-detect.ts` (extends TASK-024's module) but deliberately did NOT wire the end-to-end `browser.profileImportFromBrowser` RPC handler/dispatch case. Ported, each with a real passing test against a synthetic/known vector (not a real installed browser or live OS keychain): `getEncryptionKey`/`getMacEncryptionKey`/`getLinuxEncryptionKey`/`getWindowsEncryptionKey` (full round-trip tests recovering a known plaintext through mocked `security`/`secret-tool`/`powershell` output for all 3 platforms, including the Linux v10-"peanuts"-fallback and v11-keyring paths, and the Windows DPAPI + AES-256-GCM path), `hasHmacPrefix`/`stripHmac`, `decryptCookieValueRaw`/`decryptAes256Gcm`, `chromiumTimestampToUnix`, `validateCookieEntry`/`normalizeSameSite`/`deriveUrl`, `decodeSafariBinaryCookies` (full synthetic-buffer decode test), and the new `buildAgentBrowserCookieSetArgs` (flags confirmed against the real vendored `agent-browser` CLI's `cookies --help`, resolving the task's own open "unix timestamp vs ISO string" question — it's Unix seconds).

**Deliberately not implemented, per this task's own risk flag and the shared execute-context's rule 6:** the end-to-end `importCookiesFromInstalledBrowser` orchestration (Chromium SQLite snapshot-and-read incl. its WAL-safety dance, Firefox `cookies.sqlite` read, the live integrity-cookie skip list, and the per-cookie `agent-browser cookies set` write loop) and the `handleBrowserProfileImportFromBrowser` handler/dispatch case that would call it. Two reasons: (1) that orchestration is real host-side cookie-exfiltration machinery I cannot verify against a real installed Chrome/Firefox/Safari, a live macOS Keychain, real Windows DPAPI, or the real `agent-browser cookies set` CLI in this sandbox — shipping ~400+ more lines of that unverified risks silently corrupting or leaking real session cookies on a shared dev-server host, exactly the scenario this task's own Security Note warns about; (2) the wire-args question the task flagged as unresolved is confirmed real: freshly re-read `channels_browser_profiles.go` — `registerBrowserProfileRelay` is devServerId-only with no worktree field, and the frontend's `browserProfileImportFromBrowser` call site (`runtime-browser-client.ts:96-110`) sends `{profileId, browserFamily, browserProfile}` with no `devServerId` at all, so this handler cannot call `requireWorktreeId(params)` as the task's own sketch first proposed — it would need TASK-023's `DEFAULT_BROWSER_PROFILE_SESSION` fallback, plus a wscompat/frontend change to resolve `profileId` server-side, which is a cross-cutting change outside this file's agent-only scope. Flagging both for PR review rather than guessing past them. `npx vitest run` (25/25 new + extended cases pass; 56/56 across all 3 browser-profile test files together) and `npx tsc --noEmit` (zero new errors; same 131 pre-existing unrelated errors as before) both clean for everything actually shipped.

---

## Context

This is the genuinely hard half of SOL-009 — do not understate it as "a
third small handler." `desktop/src/main/browser/browser-cookie-import.ts`
implements a real, cross-platform, security-sensitive decryption pipeline
(1823 lines, `eslint-disable max-lines` at its own top, for exactly this
reason): three separate real decryption paths —

- **macOS**: `PBKDF2(Keychain "Chrome Safe Storage" password, salt
  "saltysalt", 1003 iterations) -> AES-128-CBC`, the Keychain password
  fetched by shelling out to the `security` CLI
  (`getMacEncryptionKey`, `browser-cookie-import.ts:952-969`).
- **Linux**: `PBKDF2(GNOME-keyring password via secret-tool, or the
  hardcoded "peanuts" for v10 cookies, salt "saltysalt", 1 iteration) ->
  AES-128-CBC` (`getLinuxEncryptionKey`, `browser-cookie-import.ts:971-1004`).
- **Windows**: `DPAPI-encrypted master key from Local State's
  os_crypt.encrypted_key -> AES-256-GCM`, decrypted by shelling out to
  `powershell` with `System.Security.Cryptography.ProtectedData`
  (`getWindowsEncryptionKey`, `browser-cookie-import.ts:1005-1066`).

Plus Chromium's HMAC-prefix detection (`hasHmacPrefix`/`stripHmac`,
`browser-cookie-import.ts:1067-1083`), Firefox's separate `cookies.sqlite`
format (`importCookiesFromFirefox`, `:1289-1393`), and Safari's binary
`Cookies.binarycookies` parser (`decodeSafariBinaryCookies` and friends,
`:1149-1270`). None of this exists in `agent/` today and none of it maps
onto any `agent-browser` CLI subcommand (confirmed by SOL-009: the CLI's
`auth save/login/list/show/delete` is an unrelated saved-credential-vault
feature, not a real-browser-profile reader). This task ports the pipeline,
targeting it at writing into an `agent-browser` session via its `cookies
set` CLI command instead of desktop's Electron-`session`-object/SQLite-DB-swap
trick (which is specific to Electron's own CookieMonster storage and does
not apply to `agent-browser`'s process).

## Security note (read before implementing)

Cookie decryption on the desktop happens inside the user's own Electron
process, on the user's own machine, using an OS keychain the user already
controls. Doing the equivalent decryption inside `agent/` means it runs on
a dev-server host that may be shared or remote —
`07-security-architecture.md`'s "Secrets" section has no model for
host-local OS-keychain decryption on the Dev Server Agent (it's entirely
about `credential-broker-service`/Vault-mediated secrets, a different
mechanism). This isn't a blocker (the desktop feature already does the
analogous thing on a machine the user trusts by definition), but this
task's implementer should confirm the target dev-server host is one the
tenant already fully controls (the existing SSH/dev-server trust model)
before treating "decrypt whatever's in this host's browser profile
directories" as safe — a compromised or shared dev server could otherwise
use this RPC to exfiltrate any locally-installed browser's saved
sessions. Flag this to whoever reviews the PR, don't silently assume it's
fine.

## Changes to make

### 1. Extend `agent/src/relay/browser-profile-detect.ts` (TASK-024's file)

Port the decryption pipeline, keeping the module boundary TASK-024
established. Add back the `keychainService`/`keychainAccount` fields to
`CHROMIUM_BROWSERS` (dropped by TASK-024 since detection-only didn't need
them) — port them verbatim from
`desktop/src/main/browser/browser-cookie-import.ts:118-167`.

Port, adapted 1:1 from the real current implementations (read each at its
cited line range before porting — this sketch is illustrative, not
byte-exact):

- `getEncryptionKey`/`getMacEncryptionKey`/`getLinuxEncryptionKey`/
  `getWindowsEncryptionKey` (`:935-1066`) — the three platform key-derivation
  paths, unchanged (they already shell out via `execFileSync`, which works
  identically in `agent/`'s Node process as in Electron's main process).
- `hasHmacPrefix`/`stripHmac`/`decryptCookieValueRaw`/`decryptAes256Gcm`
  (`:1067-1148`) — the actual decrypt step, pure `node:crypto`, no
  Electron dependency at all.
- `chromiumTimestampToUnix` (`:790-805`) — timestamp conversion.
- `validateCookieEntry`/`normalizeSameSite`/`deriveUrl` (`:469-566`) —
  shared cookie-shape validation between Chromium/Firefox/Safari paths.
- `importCookiesFromFirefox` (`:1289-1393`) and `importCookiesFromSafari`
  (`:1394-1444`) — the two non-Chromium formats. Port their read/decrypt
  logic; **do not** port their final write step (they write into an
  Electron `session` via `targetSession.cookies.set(...)`) — see step 2
  below for the agent's different target.

Add the new export, replacing desktop's DB-swap write path with
per-cookie `agent-browser cookies set` CLI calls:

```ts
// agent/src/relay/browser-profile-detect.ts — extends TASK-024's module

export type ImportCookiesResult = { ok: boolean; imported?: number; reason?: string }

export async function importCookiesFromInstalledBrowser(
  browserFamily: string,
  browserProfileDirectory: string | undefined,
  targetSession: string // agent-browser --session name to import INTO
): Promise<ImportCookiesResult> {
  const browsers = detectInstalledBrowsersOnHost() // TASK-024's export
  let browser = browsers.find((b) => b.family === browserFamily)
  if (!browser) {
    return { ok: false, reason: `${browserFamily} not found on this dev server.` }
  }
  if (browserProfileDirectory && browserProfileDirectory !== browser.selectedProfile) {
    const reselected = selectBrowserProfileOnHost(browser, browserProfileDirectory) // port of desktop's selectBrowserProfile, :400-434
    if (!reselected) {
      return { ok: false, reason: `No cookies database found for profile "${browserProfileDirectory}".` }
    }
    browser = reselected
  }

  // 1. locate + decrypt the source browser's cookie store (Chromium SQLite
  //    Cookies file via node:sqlite's DatabaseSync read-only, per
  //    createChromiumCookieSnapshot's WAL-safe copy pattern,
  //    browser-cookie-import.ts's chromium-cookie-snapshot module; Firefox
  //    cookies.sqlite; Safari's binary format) into ValidatedCookie[]
  const cookies = await decryptCookiesForBrowser(browser) // ported per-family dispatch

  // 2. write each validated cookie into agent-browser's session — one CLI
  //    call per cookie via runBrowserCommand(targetSession, [...]), unless
  //    `agent-browser cookies set` supports a bulk/stdin form (verify
  //    against the CLI's real --help output at implementation time, per
  //    SOL-009's own note — do not assume without checking)
  let imported = 0
  for (const cookie of cookies) {
    try {
      await runBrowserCommand(targetSession, buildAgentBrowserCookieSetArgs(cookie))
      imported += 1
    } catch {
      // Why: one malformed/rejected cookie must not abort the whole
      // import — matches desktop's own best-effort-per-row behavior in
      // importValidatedCookies.
    }
  }
  return { ok: true, imported }
}
```

`buildAgentBrowserCookieSetArgs` is new (no desktop equivalent — desktop
writes to a SQLite DB directly, agent shells out to the CLI): build the
`['cookies', 'set', '--url', cookie.url, '--domain', cookie.domain,
'--path', cookie.path, ...]` argument list per `agent-browser --help`'s
documented `cookies set` flags (`set supports --url, --domain, --path,
--httpOnly, --secure, --sameSite, --expires`, per SOL-009's own CLI
inspection) — verify the exact flag names/value formats against the real
CLI at implementation time (e.g. does `--expires` take a Unix timestamp or
an ISO string?), don't guess from this sketch.

### 2. `browser-handler.ts` — new handler

```ts
// ─── browser.profileImportFromBrowser ───────────────────────────────────────

export async function handleBrowserProfileImportFromBrowser(
  id: JsonRpcId,
  params: Record<string, unknown>,
  log: AgentLogger
): Promise<JsonRpcResponse> {
  try {
    const browserFamily = stringParam(params, 'browserFamily')
    const browserProfile = optionalStringParam(params, 'browserProfile')
    // Why: browserProfile becomes part of a filesystem path when locating
    // the source browser's profile directory — reject traversal the same
    // way desktop's own importFromBrowser handler already does
    // (desktop/src/main/ipc/browser.ts:563-571), since this is now
    // reachable from a remote relay call, not just a trusted local
    // renderer.
    if (browserProfile && (/[/\\]/.test(browserProfile) || browserProfile.includes('..'))) {
      throw new Error('BROWSER_MISSING_ARGS: invalid browserProfile name')
    }
    // Why: unlike profileClearDefaultCookies (TASK-023), an import target
    // needs a real worktree's agent-browser session to import into — the
    // wire args here DO carry a worktree selector for that reason (verify
    // against channels_browser_profiles.go's actual relay args for this
    // specific method before assuming the shape below — the profile-relay
    // skeleton in that file is generic across all 3 methods, but this is
    // the one method where "which session receives the cookies" is
    // meaningful in a way profileClearDefaultCookies's "default" is not).
    const worktreeId = requireWorktreeId(params)
    const { importCookiesFromInstalledBrowser } = await import('./browser-profile-detect')
    const result = await importCookiesFromInstalledBrowser(browserFamily, browserProfile, worktreeId)
    return makeSuccess(id, result) // matches BrowserProfileImportFromBrowserResult
                                    // (= BrowserCookieImportResult, frontend/src/shared/runtime-types.ts:881)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error(`browser.profileImportFromBrowser failed: ${message}`)
    return makeFailure(id, message)
  }
}
```

**Open question to resolve before finalizing this handler:** confirm
against `channels_browser_profiles.go`'s real wire args for
`profileImportFromBrowser` specifically (re-read
`backend-go/services/api-gateway/internal/adapter/wscompat/channels_browser_profiles.go`
at implementation time — TASK-023/024 already found its generic
`registerBrowserProfileRelay` carries only `devServerId`, with no worktree
field at all) whether a `worktree` param is actually present on this call,
or whether "target session" instead needs to be the same dev-server-wide
default session `TASK-023` defines. If `channels_browser_profiles.go`'s
relay args are unchanged from today (devServerId-only, no worktree), this
handler cannot call `requireWorktreeId(params)` as sketched above — it
must target the same fixed default session TASK-023 introduces, and the
frontend's `browserProfileImportFromBrowser({ profileId, browserFamily,
browserProfile })` call site
(`frontend/src/renderer/src/runtime/runtime-browser-client.ts:96-110`)
would need a corresponding change to resolve `profileId` server-side into
whichever `agent-browser` session actually owns that profile — a
proto/wscompat-layer question outside this task's `agent/`-only scope.
**Do not guess past this — resolve it against the real current
`channels_browser_profiles.go` before writing the final wire-args
handling**, and flag it in the PR description if the answer isn't obvious
from the code alone.

### 3. `agent-rpc-dispatch-browser.ts` — new case

```ts
case 'browser.profileImportFromBrowser': {
  try {
    const { handleBrowserProfileImportFromBrowser } = await import('./browser-handler')
    return (await handleBrowserProfileImportFromBrowser(rpc.id, rpc.params ?? {}, log)) as JsonRpcResponse
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return makeError(rpc.id, AgentErrorCode.ServerError, `browser.profileImportFromBrowser unavailable: ${msg}`)
  }
}
```

## Verify

```bash
cd agent
npx vitest run src/relay/browser-profile-detect.test.ts src/relay/browser-handler.test.ts src/relay/agent-rpc-dispatch-browser.test.ts
npx tsc --noEmit
```

`browser-profile-detect.test.ts` (extend TASK-024's file): port the
decryption-relevant cases from
`desktop/src/main/browser/browser-cookie-import.test.ts` — the 3 platform
key-derivation paths (mock `execFileSync` for `security`/`secret-tool`/
`powershell` the same way that suite does), HMAC-prefix stripping,
timestamp conversion, malformed-cookie-row rejection via
`validateCookieEntry`. Also check
`browser-cookie-import.comet.test.ts`/`browser-cookie-import.helium.test.ts`
for the per-browser-quirk cases (Comet/Helium's non-standard Keychain
naming) if this port is meant to support those browsers too.

`browser-handler.test.ts` (extend): traversal-character rejection for
`browserProfile` (mirrors desktop's own test for the identical guard in
`desktop/src/main/ipc/browser.ts`), missing-`browserFamily` rejection,
successful-import shape.
