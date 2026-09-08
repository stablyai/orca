# SOL-009: Implement the 3 missing `browser.profile*` agent handlers — one trivial (`agent-browser` already has it), two a real (bounded) port of desktop's cookie-decryption pipeline

**Resolves:** [BUG-009](../BUG-009-browser-profile-relay-channels-inert.md)
**Service:** `agent/` (the Dev Server Agent) — **not backend-go**. `backend-go`'s side of this (`api-gateway`'s `wscompat` relay wiring) is already complete and correct; this proposal touches zero backend-go files. See "Why this fix lives outside backend-go" below.
**Affected files (proposed):**
- `agent/src/relay/browser-handler.ts` (new: `handleBrowserProfileClearDefaultCookies`, `handleBrowserProfileDetectBrowsers`, `handleBrowserProfileImportFromBrowser`)
- `agent/src/relay/agent-rpc-dispatch-browser.ts` (new `case` for each of the 3 methods, same shape as the 12 existing cases)
- `agent/src/relay/browser-profile-detect.ts` (new — cross-platform installed-browser detection + cookie decryption, ported/adapted from `desktop/src/main/browser/browser-cookie-import.ts` for the dev-server-host case, see below)
- No backend-go files
**Status:** 🚧 Proposed — no code written

---

## Why this fix lives outside backend-go

BUG-009 already fully diagnosed the backend-go side: `channels_browser_profiles.go:16-27`'s `registerBrowserProfileRelay` loop registers all 3 channels correctly, resolves `devServerId` -> `connectionId` correctly, and calls `Relay` correctly — its own header comment says exactly what's missing: "**INERT until the agent implements these 3 methods** — see TASK-036" (`channels_browser_profiles.go:21-23`). There is no backend-go proto, usecase, or wiring work left to do here; the entire gap is that `agent/src/relay/agent-rpc-dispatch-browser.ts`'s `switch (rpc.method)` has no `case` for these 3 method names, so they fall through to the `default: return null` (`agent-rpc-dispatch-browser.ts:206-207`), which the caller turns into a generic "method not handled" error.

Per `08-inter-service-communication.md`'s "Talking to the Dev Server Agent" section, `agent/` changes are "explicitly out of scope for 'the Go rewrite of `backend/`'" (`architecture/08-inter-service-communication.md:100-102`) — the same stance `SOL-006-browser-channels.md` cites for its own out-of-scope `agent/` flag. That framing applies here too: this is not backend-go work. **But unlike SOL-006's browser-driving-from-scratch problem** — where no CDP/browser-control capability existed in `agent/` at all — this gap is narrow and the pattern to extend is already proven: 12 sibling `browser.*` methods (`goto`, `snapshot`, `click`, `eval`, `keypress`, 4 mouse ops, `viewport`, `tabCreate`, `tabClose`, plus the 2 screencast ops) already work end-to-end today, driving a real headless Chromium via the vendored `agent-browser` CLI (`agent-rpc-dispatch-browser.ts:1-10`'s header comment). Filling in 3 more `case`s that follow the exact same shape is a small, bounded task for whoever owns `agent/` — flagged as out of backend-go's scope, not as a large undertaking the way SOL-006's was.

## Confirmed: no existing browser-profile/cookie-jar concept in `agent/` to reuse

Grepped `agent/src/relay` and `agent/src` broadly for "profile" before designing from scratch, per the task brief. Every hit is unrelated: shell-profile files (`.zprofile`/`.bash_profile`/`.profile` — login-shell setup for PTY spawning, `pty-shell-launch.ts`/`pty-shell-utils.ts`/`shell-startup-env.ts`), OAuth token claims called `profileClaims` (`accounts-handler.ts:254-262`, an unrelated `accounts.*` feature), and telemetry/synthetic-title "profile" objects (unrelated config bags). **None of these are a browser-cookie-jar or installed-browser-detection concept** — confirms there is nothing to reuse inside `agent/` itself; the closest real precedent lives in `desktop/`, not `agent/` (see below).

## The 3 methods are not equally hard — split them honestly

### `browser.profileClearDefaultCookies` — trivial, maps 1:1 onto an existing `agent-browser` command

The vendored `agent-browser` CLI (pinned `~0.27.0`, `agent/package.json:30`) already has a first-class cookie-clearing command:

```
$ node agent-browser.js --help | grep -A1 cookies
Storage:
  cookies [get|set|clear]    Manage cookies (set supports --url, --domain, --path, --httpOnly, --secure, --sameSite, --expires)
```

This is exactly the same CLI `browser-handler.ts`'s existing handlers already shell out to via `runBrowserCommand` (`browser-handler.ts:184-224`). The new handler is a direct copy of the established `dispatchBrowserCommand` pattern (`browser-handler.ts:226-243`, used by e.g. `handleBrowserKeypress`, `browser-handler.ts:327-333`):

```ts
// browser-handler.ts — new handler, same shape as every sibling above it

// ─── browser.profileClearDefaultCookies ─────────────────────────────────────

export async function handleBrowserProfileClearDefaultCookies(
  id: JsonRpcId,
  params: Record<string, unknown>,
  log: AgentLogger
): Promise<JsonRpcResponse> {
  return dispatchBrowserCommand(
    id,
    params,
    log,
    'profileClearDefaultCookies',
    () => ['cookies', 'clear'],
    () => ({ cleared: true }) // matches BrowserProfileClearDefaultCookiesResult.cleared
                              // (frontend/src/renderer/src/runtime/runtime-browser-client.ts:112-126)
  )
}
```

One wrinkle worth flagging: every other `browser.*` op is scoped by `params.worktree` via `requireWorktreeId` (`browser-handler.ts:172-178`), because a worktree owns one `agent-browser --session <worktreeId>`. But `channels_browser_profiles.go`'s relay is keyed by `devServerId`, not `worktree` (`channels_browser_profiles.go:105-116`'s `relayArgs{DevServerID}` — "no worktree involved, a profile is dev-server-scoped," per that file's own comment) — so the wire params this handler receives carry no `worktree` field at all. `requireWorktreeId`/`dispatchBrowserCommand` cannot be reused unmodified for this one call; the handler needs its own params path that clears cookies against... which session? `agent-browser`'s cookie store is per-`--session`, and a dev server can have N active worktree sessions running concurrently. "Clear the *default* cookies" (the method's own name) most plausibly means the dev-server-level default profile, which this design does not have a settled definition of yet — **flagging this as the one open question in an otherwise trivial method**: does `--session` even apply here, or does this need a dev-server-wide default session name (e.g. `--session default`) distinct from any worktree's? Whoever implements this should confirm against `channels_browser_profiles.go`'s Group C table (`SOL-006-browser-channels.md`'s design) for what "default" was meant to mean before wiring the CLI call.

### `browser.profileDetectBrowsers` / `browser.profileImportFromBrowser` — a real, bounded port, not a copy-paste

These do **not** map onto anything `agent-browser`'s CLI exposes — its full `--help` output has no `detect`/`import`/`browsers` subcommand of any kind; the closest-sounding feature, `auth save/login/list/show/delete` ("Auth Vault"), is a *saved-credential autofill* feature (username/password pairs `agent-browser` itself remembers and replays into a login form) — an unrelated concept, not reading another browser's actual profile directory or cookie store. So unlike `profileClearDefaultCookies`, there is no existing command to shell out to; this is new logic `agent/` has to own itself.

The good news: this logic already exists and is proven, just in the wrong process. `desktop/src/main/browser/browser-cookie-import.ts` implements exactly this for the Electron-local case:

- `detectInstalledBrowsers()` (`browser-cookie-import.ts:355-`) enumerates Chrome, Edge, Arc, Brave, Comet, Helium (all Chromium-family, via `browserRootPath`/`discoverProfiles`), Firefox (`discoverFirefoxProfiles`), and Safari (`detectSafari`) on the host's OS.
- Importing a cookie means decrypting each browser's real cookie store — the file has three separate, real decryption paths: macOS Keychain (`PBKDF2(keychain password, "saltysalt", 1003 iterations) -> AES-128-CBC`), Windows (`DPAPI-encrypted master key from Local State -> AES-256-GCM`), and Linux, per `browser-cookie-import.ts:809-817`'s own comments and `getEncryptionKey`/`getMacEncryptionKey`/`getLinuxEncryptionKey` (`browser-cookie-import.ts:935-944`).

This is a real, cross-platform, security-sensitive pipeline — not a small helper. Porting it to `agent/` is bounded (the hard part, driving/decrypting each browser format, is already written and tested for 3 platforms; `desktop`'s own test suite — `browser-cookie-import.test.ts`, `browser-session-registry.test.ts` — is a concrete reference for behavior to preserve) but it is **not** "3 methods, same pattern, copy it" the way `profileClearDefaultCookies` is. Design sketch:

```ts
// agent/src/relay/browser-profile-detect.ts (new)
// Adapted from desktop/src/main/browser/browser-cookie-import.ts's
// detectInstalledBrowsers/getEncryptionKey/buildChromiumCookieInsertParams —
// same detection + decryption logic, ported to run on the dev-server host
// this agent process is itself running on, not the operator's own desktop.
export type DetectedBrowser = {
  family: string
  label: string
  profiles: { name: string; directory: string }[]
  selectedProfile: string
}

export function detectInstalledBrowsersOnHost(): DetectedBrowser[] { /* port of browser-cookie-import.ts:355- */ }

export async function importCookiesFromInstalledBrowser(
  browserFamily: string,
  browserProfile: string | undefined,
  targetSession: string // agent-browser --session name to import INTO
): Promise<{ ok: boolean; imported?: number; reason?: string }> {
  // 1. locate the browser's cookie DB (Chromium: SQLite Cookies file; Firefox: cookies.sqlite)
  // 2. decrypt each row via the platform-appropriate key (ported from
  //    getEncryptionKey/getMacEncryptionKey/getLinuxEncryptionKey)
  // 3. write into agent-browser's session via `agent-browser cookies set ...`
  //    per cookie (browser-handler.ts's runBrowserCommand, one call per
  //    validated cookie, or a batch if agent-browser's cookies set supports
  //    a bulk form — verify against the CLI at implementation time)
}
```

```ts
// browser-handler.ts — new handlers, following the established
// try/catch + makeSuccess/makeFailure shape (browser-handler.ts:115-121)
// rather than dispatchBrowserCommand, since these don't shell out to
// agent-browser directly for detection

export async function handleBrowserProfileDetectBrowsers(
  id: JsonRpcId,
  _params: Record<string, unknown>,
  log: AgentLogger
): Promise<JsonRpcResponse> {
  try {
    const { detectInstalledBrowsersOnHost } = await import('./browser-profile-detect')
    return makeSuccess(id, { browsers: detectInstalledBrowsersOnHost() }) // matches BrowserDetectProfilesResult.browsers
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error(`browser.profileDetectBrowsers failed: ${message}`)
    return makeFailure(id, message)
  }
}

export async function handleBrowserProfileImportFromBrowser(
  id: JsonRpcId,
  params: Record<string, unknown>,
  log: AgentLogger
): Promise<JsonRpcResponse> {
  try {
    const browserFamily = stringParam(params, 'browserFamily')
    const browserProfile = optionalStringParam(params, 'browserProfile')
    // Why: browserProfile becomes part of a filesystem path when locating the
    // source browser's profile directory — reject traversal the same way
    // desktop's own importFromBrowser handler already does
    // (desktop/src/main/ipc/browser.ts:563-571), since this is now reachable
    // from a remote relay call, not just a trusted local renderer.
    if (browserProfile && (/[/\\]/.test(browserProfile) || browserProfile.includes('..'))) {
      throw new Error('BROWSER_MISSING_ARGS: invalid browserProfile name')
    }
    const worktreeId = requireWorktreeId(params) // profileId's target session — see open question below
    const { importCookiesFromInstalledBrowser } = await import('./browser-profile-detect')
    const result = await importCookiesFromInstalledBrowser(browserFamily, browserProfile, worktreeId)
    return makeSuccess(id, result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error(`browser.profileImportFromBrowser failed: ${message}`)
    return makeFailure(id, message)
  }
}
```

```ts
// agent-rpc-dispatch-browser.ts — 3 new cases, identical shape to every
// existing one (e.g. case 'browser.keypress': above)
case 'browser.profileClearDefaultCookies': {
  try {
    const { handleBrowserProfileClearDefaultCookies } = await import('./browser-handler')
    return (await handleBrowserProfileClearDefaultCookies(rpc.id, rpc.params ?? {}, log)) as JsonRpcResponse
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return makeError(rpc.id, AgentErrorCode.ServerError, `browser.profileClearDefaultCookies unavailable: ${msg}`)
  }
}
// ...case 'browser.profileDetectBrowsers' / case 'browser.profileImportFromBrowser', same shape
```

## A product question this proposal surfaces but does not resolve

`detectInstalledBrowsers()` on the desktop enumerates browsers **installed on the user's own machine** — Chrome/Firefox/Safari the user personally logged into, with their own real session cookies. On a remote dev server, `browser.profileDetectBrowsers` instead enumerates whatever browsers happen to be installed **on the dev-server host** — a machine the user does not use for daily browsing and, in the common case (a headless Linux VM/container), likely has no Chrome/Firefox/Safari install with the user's personal cookies in it at all. The feature is mechanically portable, but its *usefulness* on a remote target is not obviously the same as on desktop — importing "the dev server's own installed browsers' cookies" is a materially different (and probably much less useful) capability than importing the user's personal browsing session. This isn't a reason to withhold the implementation — the RPC contract (`BrowserDetectedInfo[]`, `BrowserProfileImportFromBrowserResult`) is the same either way, and it's not wrong to expose it — but it's a UX/product question worth someone confirming (does the picker UI need to say "browsers found on the dev server", not just "browsers found"?) rather than silently assuming remote-target behavior should read identically to the desktop one. Flagged here rather than assumed, per this solution set's house style.

## Security note

Cookie decryption on the desktop happens inside the user's own Electron process, on the user's own machine, using that machine's own OS keychain the user already controls. Doing the equivalent decryption inside `agent/` means it runs on a dev-server host that may be shared or remote — `07-security-architecture.md` has no model at all for per-host secrets-decryption-at-rest on the Dev Server Agent (its "Secrets" section, lines 82-87, is entirely about `credential-broker-service`/Vault-mediated secrets, a different mechanism than "decrypt this OS's own local Keychain/DPAPI-protected file"). This isn't a blocker — the desktop feature already does the analogous thing on a machine the user trusts by definition (their own) — but implementers should confirm the target dev-server host is one the tenant already fully controls (the existing SSH/dev-server trust model) before treating "decrypt whatever's in this host's browser profile directories" as safe, since a compromised or shared dev server could otherwise use this RPC to exfiltrate any locally-installed browser's saved sessions.

## Test plan

- `browser-handler.test.ts` (existing file, extend): `handleBrowserProfileClearDefaultCookies` — mock `runBrowserCommand`, assert it calls `['cookies', 'clear']` and returns `{ cleared: true }`; assert failure path (mocked rejection) returns `makeFailure`.
- `browser-profile-detect.test.ts` (new): port the relevant cases from `desktop/src/main/browser/browser-cookie-import.test.ts` (detection across the 3 platform decryption paths, malformed-profile-name rejection) adapted to the new module's exports.
- `agent-rpc-dispatch-browser.test.ts` (existing file, extend): 3 new cases dispatch to the right handler, `default:` no longer matches these method names.
- End-to-end (owned by whoever picks this up, per `SOL-006`'s own scoping precedent): a real relay round-trip from `channels_browser_profiles_test.go`'s fake `Relay` client through to a live agent process is out of scope for backend-go's own test suite, since backend-go's side is already fully tested and unchanged by this proposal.

## References

- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_browser_profiles.go:16-27,105-116` — the already-correct, already-inert relay registration this proposal's `agent/` work makes live
- `agent/src/relay/agent-rpc-dispatch-browser.ts:1-10,26-208` — dispatch switch, header comment naming `agent-browser` as the driving engine, `default: return null` fallthrough
- `agent/src/relay/browser-handler.ts:167-224,271-333` — `BrowserCommandParams`/`requireWorktreeId`/`runBrowserCommand`/`dispatchBrowserCommand`, the established pattern this proposal's new handlers follow
- `agent/package.json:30` — `agent-browser: ~0.27.0`, the vendored CLI whose `cookies clear` backs `profileClearDefaultCookies`
- `desktop/src/main/browser/browser-cookie-import.ts:91-174,355-,809-944` — `detectInstalledBrowsers`, per-platform decryption (`getEncryptionKey`/`getMacEncryptionKey`/`getLinuxEncryptionKey`), the logic this proposal ports for `profileDetectBrowsers`/`profileImportFromBrowser`
- `desktop/src/main/ipc/browser.ts:502-577` — desktop's own IPC handlers for the 3 equivalent local operations, including the traversal-character rejection this proposal's `handleBrowserProfileImportFromBrowser` reuses
- `frontend/src/renderer/src/runtime/runtime-browser-client.ts:80-126` — frontend call sites and result shapes (`BrowserDetectProfilesResult`, `BrowserProfileImportFromBrowserResult`, `BrowserProfileClearDefaultCookiesResult`) this proposal's handlers must match
- `specs/backend-go/tdd/architecture/08-inter-service-communication.md:84-108` — "Talking to the Dev Server Agent," the `agent/`-out-of-scope framing this proposal cites (and narrows, since this gap is small and the pattern is proven)
- `specs/backend-go/tdd/architecture/07-security-architecture.md:82-87` — Secrets section, confirms no existing model for host-local OS-keychain decryption on the Dev Server Agent
- `specs/backend-go/bugs/missing-v1/solutions/SOL-006-browser-channels.md` — house style for honestly flagging agent-side scope, and the precedent this proposal narrows ("a bigger ask than a simple flag-and-defer" for SOL-006's browser-driving-from-scratch problem; this one is small and tractable by comparison, except for the detect/import cookie-decryption sub-feature specifically)
