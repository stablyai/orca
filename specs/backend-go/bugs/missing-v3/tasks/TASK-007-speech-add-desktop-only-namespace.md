# TASK-007: Add `'speech'` to `DESKTOP_ONLY_NAMESPACES`

**From Solution:** SOL-006 (verdict: do not implement `speech.models.*` as a backend-go RPC)
**Priority:** P1 — small, independent, no dependency on anything else in this task set; fixes a live, unclassified console-error gap today
**Service:** `frontend`
**File:** `frontend/src/renderer/src/runtime/desktop-only-rpc-error-suppressor.ts`
**Depends on:** none
**Status:** `[x]` DONE — as specified. Added `desktop-only-rpc-error-suppressor.test.ts` (none existed before, confirmed) covering: `speech.models.list`'s `method_not_found` is suppressed, an unlisted namespace's `method_not_found` is not, a non-`RuntimeRpcCallError` rejection is untouched, and a `RuntimeRpcCallError` with a different code (`forbidden`) is untouched. `pnpm vitest run src/renderer/src/runtime/desktop-only-rpc-error-suppressor.test.ts --config config/vitest.config.ts` — 4/4 pass. `npx tsc --noEmit -p .` shows zero errors in this file or `runtime-rpc-client.ts`; the repo-wide `tsc` run surfaces many pre-existing errors in unrelated files (workflow-types, agentOrchestration, terminal sessions, etc. — other in-flight work), none touching this task's files.

---

## Context

SOL-006 investigated whether `speech.models.*` (BUG-006) should be ported to `backend-go` and concluded it should not: dictation always targets the one paired desktop process holding local model files (`desktop/src/main/runtime/orca-runtime-mobile-dictation.ts:45-46`'s own comment: "Always targets this (paired) desktop — speech never routes to a worktree's SSH host"), and a `backend-go` environment is a stateless, horizontally-scaled pod fleet with no durable single-machine analogue to relay to — unlike `ephemeralVm.*`/`browser.*`, which resolve to a specific repo's Dev Server. `speech` is currently **absent** from this file's `DESKTOP_ONLY_NAMESPACES`, so a mobile client paired to a `backend-go` environment that opens the dictation setup sheet gets the raw, undifferentiated `notImplementedHandler` message surfaced almost verbatim in the UI, instead of being silently classified as an expected, permanent gap the way `ephemeralVm`/`mobile`/`orcaProfiles`/`remoteWorkspace` already are.

## Changes to make

Current file content (`desktop-only-rpc-error-suppressor.ts:30-72`, verbatim):

```ts
// Keep in sync with "Group A" in specs/backend/api/desktop-only-rpc-parity-gaps.md.
// Why 'cli'/'agentTrust' are gone from this list (2026-08-16): both moved to
// a real backend-proxies-to-Dev-Server-Agent implementation — see
// backend/src/main/runtime/rpc/methods/cli.ts and agent-trust.ts. A
// "Unknown method" for either now is a REAL bug (e.g. no connected Dev
// Server), not an expected desktop-only gap — do not re-add them here.
// 'shell' stays: only shell.pick*/pathExists/copyFile's UI call sites were
// rewired to a new in-app picker (DevServerFilePickerDialog) that bypasses
// the RPC entirely in web mode; 2 call sites (chat attachment picker,
// UntitledFileRenameDialog's directory pick) were NOT rewired yet and can
// still hit 'shell.*' as Unknown method — remove 'shell' once those land too.
// 'orcaProfiles' added 2026-08-17 (see specs/backend/api/orca-profiles-server-mode-design.md):
// desktop's local multi-profile switcher (Chrome/Firefox-style — one machine,
// swappable local app identity, `switch` relaunches the whole process). Not
// the same concept as backend's `profile.*`/ProfileService (Company→Dept→
// Team→User Postgres cascade for an already-authenticated server user) — the
// shared "profile" name is coincidental. No server-mode analogue exists for
// "which local machine identity is this process currently running as."
// 'remoteWorkspace' added 2026-08-17: syncs open tabs/panes for an SSH
// target across multiple separate desktop app processes via a snapshot file
// on the remote host's Dev Server Agent (see agent/src/relay/workspace-session-handler.ts).
// The problem it solves — many local Stores needing sync through a third
// machine — doesn't exist in server mode, where one backend's single
// Postgres-backed WorkspaceSessionState is already the one source of truth
// every browser client reads directly. Not the mobile-pairing bridge
// (that's the unrelated 'mobile' namespace) and not a duplicate of
// devServer.list ("which Dev Servers are connected" is a different concept).
const DESKTOP_ONLY_NAMESPACES: ReadonlySet<string> = new Set([
  'shell',
  'ephemeralVm',
  'mobile',
  'app',
  'updater',
  'pet',
  'ui',
  'computerUsePermissions',
  'developerPermissions',
  'e2e',
  'export',
  'localhostWorktreeLabels',
  'orcaProfiles',
  'remoteWorkspace'
])
```

Add a `'speech'` comment paragraph (following this file's own established per-entry style — one paragraph per addition, dated, citing the design doc) immediately before the `const DESKTOP_ONLY_NAMESPACES` line, and add `'speech'` as the new last entry in the `Set`:

```ts
// 'speech' added 2026-09-07 (see specs/backend-go/bugs/missing-v3/solutions/
// SOL-006-speech-models-channels.md): speech-model list/download/delete for
// voice dictation always targets the one paired desktop process holding the
// downloaded ONNX model files and (for OpenAI-provider entries) a dedicated
// local speech API-key store — dictation never routes to a worktree's SSH
// host or a repo's Dev Server (desktop/src/main/runtime/orca-runtime-mobile-dictation.ts:45-46's
// own comment). Unlike ephemeralVm.*/browser.*, there is no dev-server/
// worktree resolution step to port: a backend-go environment is a
// stateless, horizontally-scaled pod fleet with no durable single-machine
// analogue to relay this to. Remove this entry only if that verdict is
// revisited AND a real implementation ships — see that solution doc's "If
// this verdict is ever revisited" section for the two conditions that would
// need to hold first.
const DESKTOP_ONLY_NAMESPACES: ReadonlySet<string> = new Set([
  'shell',
  'ephemeralVm',
  'mobile',
  'app',
  'updater',
  'pet',
  'ui',
  'computerUsePermissions',
  'developerPermissions',
  'e2e',
  'export',
  'localhostWorktreeLabels',
  'orcaProfiles',
  'remoteWorkspace',
  'speech'
])
```

No other change in this file is needed — `desktopOnlyNamespaceFor` (`:110-124`) already matches against `DESKTOP_ONLY_NAMESPACES` generically via `UNKNOWN_METHOD_PATTERN`, so adding the one new entry is sufficient for all 3 `speech.models.*` methods (`list`/`download`/`delete`) at once.

## Verify

**No test file for this suppressor exists today** (confirmed:
`find frontend/src/renderer/src/runtime -iname "*desktop-only*"` returns only
the implementation file itself) — SOL-006's test-plan note that "existing
coverage extends automatically" assumed one exists and is not accurate for
this repo's current state. This task should add a minimal
`desktop-only-rpc-error-suppressor.test.ts` alongside the constant change,
covering at least: `'speech.models.list'`'s `method_not_found` rejection is
suppressed (`event.preventDefault()` called, no console error), an
unlisted namespace's `method_not_found` rejection is NOT suppressed, and a
non-`RuntimeRpcCallError`/non-`method_not_found` rejection is never touched
— exercising `installDesktopOnlyRpcErrorSuppressor`/
`_uninstallDesktopOnlyRpcErrorSuppressorForTests` (`:78-92`) around a
dispatched `PromiseRejectionEvent`.

```bash
cd frontend
pnpm test -- src/renderer/src/runtime/desktop-only-rpc-error-suppressor.test.ts   # package.json's "test": "vitest run --config config/vitest.config.ts"
```
