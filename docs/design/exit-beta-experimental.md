# Design Doc: Exit Beta/Experimental — SSH & Terminal Persistence

**Author:** Jinwoo Hong
**Date:** 2026-04-29
**Status:** Draft

## Summary

Promote two features out of their beta/experimental state:

1. **SSH** — Remove the "Beta" badge from the settings UI. No behavioral change.
2. **Terminal persistence (daemon)** — Remove the experimental toggle and dual code path entirely. The daemon becomes the intended PTY provider for local terminals. There is no user-facing setting. If the daemon fails to start, `LocalPtyProvider` remains as the implicit fallback (it is initialized at module load in `ipc/pty.ts:31` and only replaced on daemon success).

## Motivation

- **SSH** has been stable since launch; the badge is stale.
- **Terminal persistence** has been opt-in experimental since v1.3.1 and has been tested internally for several weeks. Maintaining two code paths (daemon vs. `LocalPtyProvider`) is a real maintenance burden — every terminal feature must be tested against both providers, conditional branches clutter startup and reconnection logic, and the `cleanupOrphanedDaemon` path only exists to support toggling the feature off. Removing the dual path simplifies the codebase and makes the daemon the single, well-tested path.

## Non-Goals

- Removing `LocalPtyProvider` itself — it's still used for SSH/remote terminals.
- Changing daemon behavior or protocol.
- Touching the other experimental features (Agent Dashboard, Agent Orchestration).

## Alternatives Considered

| Approach | Description | Tradeoff |
|----------|-------------|----------|
| **Always-on, no toggle (chosen)** | Remove the setting entirely. Daemon is the sole local PTY path. | Maximum code simplification. No escape hatch — any daemon regression requires a hotfix. Acceptable given internal testing and existing crash telemetry. |
| **Hidden kill switch** | Remove UI toggle, keep a hidden `settings.json` key for 2 releases. | Same UX simplification but undocumented — support burden for an invisible setting. |
| **Flip default + keep toggle** | Change default to `true`, keep the toggle visible for 1-2 releases. | Lowest risk but doesn't solve the dual code path maintenance cost. Also requires a one-shot migration in `persistence.ts` because persisted `false` overrides new defaults (the settings store merges as `{ ...defaults.settings, ...parsed.settings }`). |

## Design

### 1. SSH — Remove Beta Badge

| File | Change |
|------|--------|
| `src/renderer/src/components/settings/Settings.tsx:384` | Remove `badge: 'Beta'` from SSH nav section |
| `src/renderer/src/components/settings/Settings.tsx:700` | Remove `badge="Beta"` from `<SettingsSection>` |

### 2. Terminal Persistence — Always-On Daemon

#### 2a. Remove setting fields

Since the setting is being removed entirely (not flipped), no migration is needed — the code no longer reads these keys, so stale persisted values are inert.

| File | Change |
|------|--------|
| `src/shared/types.ts:1014` | Remove `experimentalTerminalDaemon: boolean` |
| `src/shared/types.ts:1018` | Remove `experimentalTerminalDaemonNoticeShown: boolean` |
| `src/shared/constants.ts:182-183` | Remove both default values |

#### 2b. Simplify main-process startup

Remove the `daemonEnabled` branch. Always call `initDaemonPtyProvider()`. Keep the try/catch so the app still opens if the daemon fails — `LocalPtyProvider` is initialized at module load in `ipc/pty.ts:31` and serves as the implicit fallback, so terminals still work (just without cross-restart persistence).

| File | Change |
|------|--------|
| `src/main/index.ts:19` | Remove `recordPendingDaemonTransitionNotice` from the import: keep only `import { setAppRuntimeFlags } from './ipc/app'` |
| `src/main/index.ts:399-430` | Replace the entire `daemonEnabled` if/else block with an unconditional try/catch around `initDaemonPtyProvider()`. Remove `cleanupOrphanedDaemon` branch, `recordPendingDaemonTransitionNotice` call, and `daemonEnabled` / `daemonStarted` variables. |

**Before:**
```ts
const daemonEnabled = store.getSettings().experimentalTerminalDaemon === true
let daemonStarted = false
if (daemonEnabled) {
  try {
    await initDaemonPtyProvider()
    daemonStarted = true
  } catch (error) { ... }
} else {
  try {
    const result = await cleanupOrphanedDaemon()
    if (result.cleaned) {
      recordPendingDaemonTransitionNotice({ killedCount: result.killedCount })
    }
  } catch (error) { ... }
}
```

**After:**
```ts
try {
  await initDaemonPtyProvider()
} catch (error) {
  console.error('[daemon] Failed to start daemon PTY provider:', error)
}
```

Note: `daemonStarted` is removed here — its only consumer was `daemonEnabledAtStartup` in `setAppRuntimeFlags`, which is removed in section 2c.

#### 2c. Remove `daemonEnabledAtStartup` runtime flag

Since the daemon is always started, the `daemonEnabledAtStartup` flag is always `true` and can be removed. The ExperimentalPane used it to show a "restart required" banner — that UI is also being removed.

| File | Change |
|------|--------|
| `src/main/ipc/app.ts:9-12` | Remove `daemonEnabledAtStartup` from `AppRuntimeFlags` type |
| `src/main/ipc/app.ts:32` | Remove `daemonEnabledAtStartup: false` from default flags |
| `src/main/index.ts:432` | Remove `daemonEnabledAtStartup: daemonStarted` from `setAppRuntimeFlags` call |
| `src/preload/api-types.ts:275` | Remove `daemonEnabledAtStartup: boolean` from preload `AppRuntimeFlags` |

#### 2d. Simplify renderer reconnection logic

Remove all `daemonEnabled` checks. Always use daemon reattach path. Always populate `pendingReconnectPtyIdByTabId`.

| File | Change |
|------|--------|
| `src/renderer/src/components/terminal-pane/pty-connection.ts:716` | Remove `const daemonEnabled = storeSnapshot.settings?.experimentalTerminalDaemon === true`. |
| `src/renderer/src/components/terminal-pane/pty-connection.ts:717-726` | Remove or rewrite the "Why" comment block explaining the daemon-off path — that path no longer exists. |
| `src/renderer/src/components/terminal-pane/pty-connection.ts:739` | Replace `daemonEnabled ? detachedLivePtyId : null` with just `detachedLivePtyId`. With the daemon always on, same-session reattach after splits should always attempt to reconnect (the `null` branch was the daemon-off fallback). |
| `src/renderer/src/store/slices/terminals.ts:1426-1428` | Remove `const daemonEnabled = s.settings?.experimentalTerminalDaemon === true` and the `if (daemonEnabled)` guard. Always populate `pendingReconnectPtyIdByTabId`. |

#### 2e. Remove experimental UI

Remove the entire "Persistent terminal sessions" toggle block from the Experimental pane.

| File | Change |
|------|--------|
| `src/renderer/src/components/settings/ExperimentalPane.tsx:61-73` | Remove the `daemonEnabledAtStartup` state and its `useEffect` fetch. |
| `src/renderer/src/components/settings/ExperimentalPane.tsx:85` | Remove the `showDaemon` search-match check. |
| `src/renderer/src/components/settings/ExperimentalPane.tsx:121-122` | Remove the `pendingDaemonRestart` derived state. |
| `src/renderer/src/components/settings/ExperimentalPane.tsx:141-211` | Remove the entire `{showDaemon ? (...) : null}` block (toggle + restart banner). |
| `src/renderer/src/components/settings/experimental-search.ts:3-19` | Remove the "Persistent terminal sessions" search entry (first entry in the array). |
| `src/renderer/src/components/settings/ExperimentalPane.tsx:85-91` | After removing the first search entry, the hardcoded array indices shift. Update: `showAgentDashboard` reads `EXPERIMENTAL_PANE_SEARCH_ENTRIES[0]` (was `[1]`), `showOrchestration` reads `EXPERIMENTAL_PANE_SEARCH_ENTRIES[1]` (was `[2]`). Remove the `showDaemon` line entirely. |

#### 2f. Remove upgrade transition toast

| File | Change |
|------|--------|
| `src/renderer/src/App.tsx:498-555` | Remove the entire `useEffect` block for the "persistent terminal sessions are now opt-in" toast and the `transitionNoticeHandledRef`. |

#### 2g. Remove transition-toast IPC plumbing

All transition-notice code lives in `src/main/ipc/app.ts` (not `daemon-init.ts`):

| File | Change |
|------|--------|
| `src/main/ipc/app.ts:23-29` | Remove the `DaemonTransitionNotice` type definition. |
| `src/main/ipc/app.ts:35` | Remove the `pendingDaemonTransitionNotice` variable. |
| `src/main/ipc/app.ts:41-43` | Remove the `recordPendingDaemonTransitionNotice` function. |
| `src/main/ipc/app.ts:48-56` | Remove the `app:consumeDaemonTransitionNotice` IPC handler inside `registerAppHandlers`. |
| `src/preload/api-types.ts:279-281` | Remove the `DaemonTransitionNotice` type. |
| `src/preload/api-types.ts:289-293` | Remove the `consumeDaemonTransitionNotice` method and its JSDoc from the `AppApi` type. |
| `src/preload/index.ts:7` | Remove `DaemonTransitionNotice` from the import. |
| `src/preload/index.ts:179-180` | Remove the `consumeDaemonTransitionNotice` bridge method. |

#### 2h. Remove orphan-cleanup code

With no toggle to disable the daemon, `cleanupOrphanedDaemon` is unreachable. Evaluate whether it has any other callers:

| File | Change |
|------|--------|
| `src/main/daemon/daemon-init.ts` | Remove the exported `cleanupOrphanedDaemon` function (line 357). **Keep** `OrphanedDaemonCleanupResult` (line 233) — it is the return type of `cleanupDaemonForProtocol`. **Keep** `cleanupDaemonForProtocol` (line 242) — it is still called by `createOutOfProcessLauncher`'s shutdown callback (line 82). Remove `recordPendingDaemonTransitionNotice` import if present. |
| `src/main/daemon/daemon-init.test.ts` | Remove tests for `cleanupOrphanedDaemon`. |

#### 2i. Update tests

| File | Change |
|------|--------|
| `src/renderer/src/components/terminal-pane/pty-connection.test.ts` | Remove test cases that mock `experimentalTerminalDaemon: false`. Also remove `experimentalTerminalDaemon` from the local `StoreState` type definition (line 17). |
| `src/renderer/src/store/slices/store-session-cascades.test.ts` | Remove test cases for daemon-disabled path. |
| `src/main/codex-accounts/service.test.ts` | Remove `experimentalTerminalDaemon` and `experimentalTerminalDaemonNoticeShown` from mock settings. |
| `src/main/codex-accounts/runtime-home-service.test.ts` | Same. |

## Migration

### No settings migration needed

Unlike the "flip default + keep toggle" approach, removing the setting entirely means the code never reads `experimentalTerminalDaemon` from persisted settings. The stale key persists in users' `settings.json` as an inert entry — the app ignores unknown keys. No one-shot migration is required.

### Existing users with daemon OFF (the majority)

On next launch, the daemon starts unconditionally. Terminals begin persisting across restarts — a silent upgrade in behavior.

### Existing users with daemon ON

No behavior change — the daemon was already running.

### Stale settings keys

The removed keys (`experimentalTerminalDaemon`, `experimentalTerminalDaemonNoticeShown`) persist as inert entries in `settings.json`. No cleanup needed — they'll be naturally pruned if/when a settings schema validator is added.

## Risks

| Risk | Mitigation |
|------|------------|
| Daemon crash on startup | Keep the try/catch around `initDaemonPtyProvider()`. `LocalPtyProvider` is initialized at module load in `ipc/pty.ts:31` and only replaced on daemon success — so terminals still work, just without cross-restart persistence. The app opens; user can report the bug. |
| Daemon instability at 100% population | The daemon has been tested internally for several weeks and has been stable for opt-in users since v1.3.1. Monitoring via existing crash telemetry. |
| No user escape hatch to disable | If a critical daemon bug surfaces, we ship a hotfix. Maintaining a permanent dual code path is not worth the maintenance cost for a hypothetical. |

## Testing

- Verify fresh install: daemon starts, terminals persist across restart.
- Verify upgrade from daemon OFF: daemon starts on next launch, stale settings key is inert.
- Verify upgrade from daemon ON: no behavior change.
- Verify SSH badge is gone in settings.
- Verify Experimental pane no longer shows the terminal persistence toggle.
- Verify daemon startup failure: app still opens, error logged.
- Verify `cleanupOrphanedDaemon` is unreachable and removed.

## Implementation Notes

- **Ship SSH badge removal and daemon changes as separate commits** so the SSH change can be reverted independently.
- `docs/design/persist-ssh-sessions.md` references `experimentalTerminalDaemon` and the `daemonEnabled` guard in code snippets at lines 261 and 270. Either update the snippets to remove the guard or add a note at the top marking daemon-gated snippets as outdated post-this-change.
