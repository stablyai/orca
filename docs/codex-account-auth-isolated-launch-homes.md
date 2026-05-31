# Codex Account Auth-Isolated Launch Homes

## Problem

Orca stopped launching Codex from the user's global `~/.codex` because global hook and config mutations were intrusive. The current Orca-owned host runtime home is shared across accounts:

- [src/main/codex-accounts/runtime-home-service.ts](../src/main/codex-accounts/runtime-home-service.ts:105) prepares launch and rate-limit homes.
- [src/main/codex-accounts/runtime-home-service.ts](../src/main/codex-accounts/runtime-home-service.ts:146) materializes the active account by writing `auth.json` into the shared runtime home.
- [src/main/ipc/pty.ts](../src/main/ipc/pty.ts:608) injects the selected `CODEX_HOME` into new PTYs.
- [src/renderer/src/lib/codex-session-restart.ts](../src/renderer/src/lib/codex-session-restart.ts:24) marks only currently foreground Codex processes for restart after account switches.

PR #1629 fixed stored credential clobbering by verifying identity before read-back. That prevents Account A tokens from being saved into Account B's managed account. It does not remove the live-process race where Account A can still write the shared runtime `auth.json` after the user selects Account B, and a later launch can observe Account A before Orca re-syncs.

## Goal

Account switching should switch only Codex identity. Config, `/model`, `/fast`, hooks, sessions, skills, plugins, prompts, themes, and usage history should behave like one shared Codex environment.

Implementation should isolate only `auth.json` by selected account while preserving one shared Orca Codex environment for every other file Codex needs.

## Core Invariants

- Native `~/.codex` is user-owned. Orca may read/copy from it, but Orca-owned hooks and runtime config live in Orca userData.
- `codex-runtime-home/home` is the single shared Orca Codex environment.
- Host launch homes may contain a real selected `auth.json`. Known shared Codex entries resolve to the shared environment or are reconciled back into it before another selected launch home is prepared.
- Account switching cannot mutate the process environment of already-open PTYs. Existing host PTYs that were opened under the old account are stale until restarted, even if no Codex process is currently foregrounded.

## Non-goals

- Do not return to mutating the user's global `~/.codex` for Orca hooks or runtime config.
- Do not make account switching fork user preferences or session history by account.
- Do not remove the existing #1629 read-back guard; it is still needed for token refresh persistence.
- Do not redesign SSH remote Codex home handling in this change. SSH still uses the remote user's Codex home and remote hook install flow.
- Do not add visible product UI unless validation shows the existing account switcher becomes misleading.

## Design

1. Split host Codex runtime storage into a shared environment home and selected launch homes.

   Keep `codex-runtime-home/home` as the shared environment home. It owns `config.toml`, `hooks.json`, linked/copied user resources, and shared `sessions`.

   Add selected launch homes under `codex-runtime-home/launch/host/<selection>/home`, where `<selection>` is `system` or `account-<sha256(account id)>`. These homes contain a real `auth.json` for the selected identity and links/copies/reconciled files for non-auth entries back to the shared environment home. Raw account ids, emails, and workspace labels must never be used as path segments.

2. Prepare the shared environment first.

   Host `prepareForCodexLaunch()` and `prepareForRateLimitFetch()` continue to sync system resources, config, hooks, and sessions into the shared environment home before preparing a launch home. This keeps `/model`, `/fast`, hook trust, and session history shared for fresh host launches.

3. Put only auth in the selected launch home.

   For managed accounts, copy the selected managed account's `auth.json` into that account's launch home. For system default, mirror the current system-default auth into the system launch home or remove `auth.json` if the user is logged out.

   Read-back still uses the existing identity guard and persists refreshed tokens to the matching managed account. After read-back, the launch home is re-written from the selected source of truth.

4. Link non-auth launch-home entries to the shared environment.

   The launch home exposes Orca's known shared Codex entries except `auth.json` and Orca metadata by symlink/junction where possible. This includes `config.toml`, `hooks.json`, `history.jsonl`, `sessions`, and resource entries (`skills`, `plugins`, `plugin-state`, `profile-v2`, `themes`, `prompts`).

   Mutable directories (`sessions`, `plugin-state`, `profile-v2`) require real directory links/junctions. Plain copy fallback is not behavior-preserving because it forks session/state by account.

   Mutable files (`config.toml`, `history.jsonl`, and `profile-v2` when file-shaped) should use real symlinks where possible. On Windows filesystems that reject file symlinks, Orca may use an owned fallback copy only if it reconciles launch-home mutations back into the shared environment before preparing any launch home. This covers both direct writes and atomic rename over a symlink.

   `hooks.json` is stricter: if file linking fails, Orca does not silently copy it into the launch home. A copied hook file can change the trusted hook path, which is worse than a missing hook because it can look enabled while Codex rejects it.

   Read-mostly resource entries may use marker-owned copy fallback when links fail. Markers must let Orca refresh/remove only entries it created.

5. Do not launch new host Codex sessions from the shared environment home.

   `prepareForCodexLaunch()` and rate-limit fetches return the selected launch home. Old sessions that already point at `codex-runtime-home/home` can continue to exist, but fresh launches no longer share their `auth.json` path. Read-back for refreshed tokens is launch-home scoped; `codex-runtime-home/home/auth.json` is ignored for deciding the active account of fresh host launches.

6. Keep session and usage aggregation shared.

   Because `sessions` in launch homes links to the shared environment, Codex writes one shared session tree. Existing usage scanning can continue to read `getOrcaManagedCodexHomePath()/sessions`.

7. Handle Windows and macOS explicitly.

   On Windows, directory links use junctions when possible and file links may fail without Developer Mode. Mutable file fallback therefore requires reconciliation; mutable directory fallback must not silently copy. On macOS/Linux, symlinks should work. The fallback path must preserve behavior, not just tests.

8. Keep WSL behavior stable in this change.

   Existing WSL runtime homes are already per-distro and selected by target. This change does not solve same-distro WSL multi-account stale-auth races; that remains a residual risk. Tests should prove host Windows WSL path stripping still works and host launch homes do not leak into WSL.

9. Clean up launch-home credentials.

   Every launch home has a `.orca-managed-launch-home` marker. Removing a managed account removes that account's marked host launch home after containment verification. System logout removes only the system launch home's `auth.json`.

## Data Flow

- Account switch:
  - Persist selected account id in settings.
  - Read back refreshed tokens from the previous selected launch auth path only if identity matches. As a compatibility fallback, a matching old shared-home refresh may be persisted to the outgoing account, but never to the incoming account.
  - Prepare selected launch home.
  - Rate-limit fetch runs against selected launch home.

- New Codex terminal:
  - Main resolves target from PTY shell/cwd.
  - Host target calls `prepareForCodexLaunch()`.
  - Shared environment home is synced.
  - Selected launch home is materialized.
  - `CODEX_HOME` and `ORCA_CODEX_HOME` point to selected launch home.

- Old live Codex process:
  - Continues writing whichever home it launched from.
  - If it was launched before this change from the shared home, the read-back guard still prevents managed-account corruption.
  - Fresh launches do not read the old process's shared `auth.json`.

- Old idle shell:
  - Keeps the `CODEX_HOME` environment it was spawned with.
  - If the user later runs `codex` inside that shell, it can still use the old account.
  - The UI must mark affected host terminal sessions stale or clearly limit the guarantee to fresh PTYs.

```text
native ~/.codex
  user resources/config source only

Orca/codex-runtime-home/home
  shared config.toml, hooks.json, sessions, resources

Orca/codex-runtime-home/launch/host/account-a/home
  auth.json          real file for account A
  config.toml        link/copy to shared home
  hooks.json         link to shared home when supported
  sessions/          directory link/junction to shared home
  skills/plugins/... link or owned copy fallback to shared home
```

## Edge Cases

- Old shared-home Codex process writes stale Account A auth after selecting Account B.
- Account A and Account B have the same email but different provider/workspace ids.
- Two managed accounts have ambiguous identity fields.
- Managed account auth is missing or corrupt.
- System default logout removes `~/.codex/auth.json`.
- System default auth refreshes outside Orca.
- Symlink creation fails on Windows for file links.
- A shared config/resource entry is deleted after a launch-home link or fallback copy exists.
- Launch-home fallback copy exists but the user edited it manually.
- Codex creates a new top-level file in a launch home that Orca does not know is shared state.
- Daemon reattach points at an old PTY with old `CODEX_HOME`.
- Idle shell opened as Account A later runs Codex after switching to Account B.
- WSL shell launched from Windows must not receive a host launch-home path.
- macOS/Linux symlinks must use relative/absolute targets without Windows junction behavior.
- Codex atomically rewrites `config.toml` over a launch-home symlink or fallback copy.
- Account removal leaves copied launch-home credentials behind.

## Test Plan

- Unit: host managed Account A and Account B receive different selected launch-home paths.
- Unit: Account A launch home and Account B launch home share `config.toml`, `hooks.json`, resources, and `sessions` with the shared environment home.
- Unit: stale shared runtime `auth.json` from Account A does not affect Account B launch home after selecting Account B.
- Unit: refreshed tokens written in Account A launch home read back to Account A, then Account B launch home remains Account B.
- Unit: system default launch home mirrors system auth and handles logout.
- Unit: Windows link fallback creates owned copies and never overwrites user-edited launch-home files.
- Unit: mutable file fallback reconciles an Account A launch-home `config.toml` mutation before Account B launch prep.
- Unit: atomic rename over a launch-home `config.toml` symlink/fallback is reconciled back to shared config.
- Unit: account removal deletes the marked account launch home auth.
- Unit: removing an account that never launched does not create a new empty launch-home directory.
- Unit: WSL target behavior and Windows WSL path stripping remain unchanged.
- Typecheck: `pnpm run tc:node`, `pnpm run tc:cli`, `pnpm run tc:web`.
- Lint: `pnpm run lint`.
- Electron validation: launch Orca dev on Windows, create fake managed Codex account state through IPC/store where possible, create a terminal, verify visible terminal exists, and verify backing PTY env/session points at a selected launch home. Capture account settings/status bar and terminal screenshots. On macOS, validate through CI/subagent or targeted path/link tests where local hardware is unavailable.

## UI Quality Bar

No intentional UI change. Existing account switcher and terminal restart prompt must remain visually unchanged: no clipping, broken menu layout, stale loading state, or misleading account label.

## Review Screenshots

1. Settings > Accounts > Codex showing managed accounts and active account state.
2. Status bar Codex account switcher open after account data loads.
3. A terminal created after account selection, visibly ready.

## Rollout

1. Add path helpers for shared environment home and selected host launch homes.
2. Add launch-home materialization with link/copy fallback and owned markers.
3. Route host `prepareForCodexLaunch()` and `prepareForRateLimitFetch()` to selected launch homes.
4. Keep existing read-back guard but make it read from the relevant selected launch auth path when possible.
5. Add regression tests for stale auth, shared non-auth entries, fallback copies, and WSL no-regression.
6. Fix the current CLI typecheck include for `codex-config-sync-state.ts`.

## Lightweight Eng Review

- Scope: keep the change host-local and auth-isolation-only. Do not fork config/session/resource semantics by account and do not change SSH remote homes.
- Architecture/data flow: `codex-runtime-home/home` remains the shared environment boundary used by config mirror, hook service, session bridge, and usage scanner. `runtime-home-service` owns selected launch-home materialization because it already owns launch preparation and auth read-back.
- Failure modes covered:
  - stale old-process writes to shared `auth.json`
  - token refresh read-back to wrong account
  - file link failures on Windows
  - stale owned fallback copies
  - missing/corrupt auth files
  - WSL host-path leakage
  - daemon reattach to old session
- Test coverage required:
  - `src/main/codex-accounts/runtime-home-service.test.ts` for selected launch homes, auth isolation, system default, and stale writes
  - `src/main/codex/codex-home-paths.test.ts` or new targeted tests for link/copy fallback helpers
  - `src/main/ipc/pty.test.ts` for selected launch-home env injection and WSL stripping
  - targeted Electron validation for visible account switcher and terminal creation
- Performance/blast radius: launch prep adds a small fixed set of link/copy checks per Codex launch. Avoid recursive full-home copying. Fallback copies are limited to known entries and marker-owned refreshes.
- UI quality bar: not UI-visible; existing Settings/status-bar account controls must not regress.
- Required review screenshots:
  1. Codex account settings state
  2. Status-bar switcher state
  3. Terminal after selected-account launch
- Residual risks:
  - A pre-change live Codex process launched from the old shared home can still mutate the old shared `auth.json`; fresh launches should no longer consume it.
  - A pre-switch idle shell cannot have its process environment changed; it must be restarted or marked stale.
  - Same-distro WSL launch homes remain out of scope for this host-focused change.
  - Unknown Codex-created top-level launch-home files are not adopted into shared state until Orca explicitly classifies them. This avoids crashing or copying locked live sqlite files, but it means "everything except auth" is guaranteed only for the known shared entries above.
  - If Codex stores account-sensitive data outside `auth.json`, sharing sessions/state may need a later narrower exception.
