# BACKLOG-004: Wire up `browser.profileImportFromBrowser`'s real cookie-import orchestration

**Origin:** `specs/backend-go/bugs/missing-v3/tasks/TASK-025-agent-browser-profile-import-from-browser.md` (`[partial]`)
**Priority:** Low — narrow feature (importing cookies from a locally-installed browser into Orca's managed browser profile, on the *dev-server* host); the safe groundwork is already done
**Blocked on:** Needs real-browser / live-OS-keychain testing before it's safe to ship, which this environment can't provide

---

## What this is

`browser.profileImportFromBrowser` should let a user import cookies from a
browser already installed on the dev-server host into Orca's own managed
browser profile. Two sibling methods (`profileClearDefaultCookies`,
`profileDetectBrowsers`) are already fully implemented and shipped in
`agent/src/relay/`. This one is the remaining, harder piece.

## What's already done (safe to build on, not to redo)

Ported and unit-tested into `agent/src/relay/browser-profile-detect.ts`,
each with a real passing test against a synthetic/known vector:

- `getMacEncryptionKey`/`getLinuxEncryptionKey`/`getWindowsEncryptionKey` —
  full round-trip decrypt tests through mocked `security`/`secret-tool`/
  `powershell` output for all 3 platforms (macOS Keychain, Linux
  keyring + the "peanuts" v10 fallback, Windows DPAPI + AES-256-GCM).
- `decryptCookieValueRaw`/`decryptAes256Gcm`, `hasHmacPrefix`/`stripHmac`,
  `chromiumTimestampToUnix`, `validateCookieEntry`/`normalizeSameSite`/
  `deriveUrl`, `decodeSafariBinaryCookies` (full synthetic-buffer decode
  test), `buildAgentBrowserCookieSetArgs` (flags confirmed against the real
  vendored `agent-browser` CLI's `cookies --help` — the "Unix timestamp vs
  ISO string" question is resolved: Unix seconds).

## What's deliberately NOT done, and why

The actual live orchestration — reading a real Chromium/Firefox SQLite
cookie database (including a live browser's WAL snapshot), the integrity/
skip-list handling, and the real write loop calling `agent-browser cookies
set` for each imported cookie — was **not** wired into the
`browser.profileImportFromBrowser` RPC handler/dispatch case. Reasoning
(from the implementer, not a rushed guess): that remaining ~400+ lines is
**unverifiable against real browser/live OS keychain data in a sandboxed
CI/agent environment** — shipping untested decryption/import code that
handles real user credentials (cookies, including auth cookies) is exactly
the class of risk this pass's own "don't push through something risky"
rule exists to catch.

There's also an open, unresolved **wire-args question** flagged during
investigation: `channels_browser_profiles.go` is currently `devServerId`-
only (no `worktreeId` field), and the frontend's
`browserProfileImportFromBrowser` call site sends no `devServerId` at all —
this needs a small cross-cutting `wscompat`/frontend contract fix before
the live orchestration piece can even be wired in, independent of the
decryption work itself.

## What it would take to finish

1. Resolve the wire-args mismatch first (small, `wscompat` + frontend).
2. Port the real Chromium (SQLite, handling WAL mode) and Firefox (SQLite,
   different schema) cookie-database readers from
   `desktop/src/main/browser/browser-cookie-import.ts` to run against the
   dev-server host's filesystem instead of the desktop's own.
3. Wire the ported readers + the already-tested decrypt primitives + the
   already-tested `buildAgentBrowserCookieSetArgs` into a real
   `handleBrowserProfileImportFromBrowser` in `agent/src/relay/browser-handler.ts`,
   with the dispatch case added to `agent/src/relay/agent-rpc-dispatch-browser.ts`.
4. **Before shipping**: real, manual, cross-platform testing against actual
   installed browsers with real cookies on real macOS/Windows/Linux hosts —
   this genuinely cannot be validated by unit tests alone given the
   OS-keychain/live-file dependency, so budget for that as part of the work,
   not an afterthought.

## References

- `agent/src/relay/browser-profile-detect.ts` — the safe, tested primitives to build on
- `desktop/src/main/browser/browser-cookie-import.ts` — the real desktop precedent to port
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_browser_profiles.go` — where the wire-args fix belongs
- `frontend/src/renderer/src/runtime/runtime-browser-client.ts` — the frontend call site needing the `devServerId`/`worktreeId` fix
