# Agent Dashboard: remove experimental toggle, default-on for everyone

## Goal

Remove the `experimentalAgentDashboard` setting and its UI toggle in `ExperimentalPane`. The "Detailed agent activity" feature (inline per-card agent rows for Claude/Codex/Gemini hook events, plus retained "done" snapshots) becomes the default behavior for all users on first launch of the new build.

## Motivation

The feature has been opt-in behind an experimental switch. We want every user to see live agent activity without having to discover the toggle in settings. Cursor's hook path is already always-on; this change brings Claude/Codex/Gemini in line.

## When does it start working?

Managed hook installation runs once at `app.whenReady()` in `src/main/index.ts`. After upgrading to the new build:

- **First launch** writes hook scripts into the user's global agent configs (`~/.claude/settings.json`, `~/.codex/...`, `~/.gemini/...`) and starts the local hook server. The renderer immediately stops gating UI on the flag, so inline agent rows render as soon as hook events start arriving.
- **Newly-spawned agent processes** pick up the hooks via PTY env vars set on spawn — they report status from their first `UserPromptSubmit` onward.
- **Agent sessions already running in pre-existing PTYs** (e.g. a Claude session left open across the upgrade) will not retroactively start reporting. The agent reads its hooks config at startup, so the user must start a new agent session in that pane. This is an acceptable one-time gap — the rows will be empty until the user runs an agent.

No restart required after the upgrade itself; the moment the new build launches, the feature is live.

**Concurrent old/new builds.** The managed hook configs live in user-global paths shared across every running Orca instance. If a user has both an old build (gate off) and a new build (gate on) running at once, the new build installs the hook scripts on first launch and writes them to `~/.claude/settings.json` etc. The old build leaves them alone — its install path was already a no-op when the gate was off — so there is no install-time conflict. Hook events from agents spawned by the old build will still hit the (now-running) hook server on `127.0.0.1` and be forwarded to whichever build is the current Electron focus owner; this is the same last-writer behavior the feature already had between two new builds, just one degree more visible. Acceptable: no event corruption, no install thrash. Only effect is that the old build's renderer still won't render inline rows because its gate is still off — events arrive but are dropped client-side. No action required.

## Changes

### 1. Settings + persistence

- `src/shared/types.ts:1217` — remove `experimentalAgentDashboard` from `GlobalSettings`. (Deprecation alternative: leave the field as `boolean` typed and just stop reading it. We're removing it entirely. Note: `src/main/persistence.ts:159` spreads `...parsed.settings` into the result, so persisted JSON containing the now-unknown key will round-trip on disk indefinitely. That's harmless — nothing reads it, and TypeScript ignores extra runtime keys — but reviewers should not expect a silent drop.)
- `src/shared/constants.ts:203` — drop the `experimentalAgentDashboard: false` default.
- `src/main/persistence.ts:191-211` — **widen the inline-agents migration to fire unconditionally**. Currently it only appends `'inline-agents'` to `worktreeCardProperties` when the experiment was on. Now every existing user (including those who had the toggle off, which is the majority) needs `'inline-agents'` added once so they see the feature out of the box. The `_inlineAgentsDefaultedForExperiment` flag still prevents re-firing after a deliberate uncheck.
- `src/main/persistence.test.ts:622-701` — rewrite the four tests to assert unconditional appending. The "experimental toggle is off" test is deleted (that branch no longer exists), and the toggle-on test is rewritten as "adds inline-agents on first load after upgrade" with no `experimentalAgentDashboard` field in the input.

### 2. Main process

- `src/main/index.ts:285` — remove the gate around `mainWindow.webContents.send('agentStatus:set', …)`. Forward unconditionally.
- `src/main/index.ts:459-472` — remove the `agentDashboardEnabled` gate; install Claude/Codex/Gemini managed hooks unconditionally. Keep the per-installer try/catch — install must remain fail-open so a malformed local config never bricks Orca.
- `src/main/index.ts:550-552` — `setAppRuntimeFlags({ agentDashboardEnabledAtStartup })` becomes dead. Drop the call.

### 3. Runtime-flag IPC plumbing (dead code)

- `src/main/ipc/app.ts:9-22, 29` — delete `AppRuntimeFlags`, `runtimeFlags`, `setAppRuntimeFlags`, the `app:getRuntimeFlags` handler.
- `src/preload/api-types.ts:346` — drop `agentDashboardEnabledAtStartup` from the runtime-flags type.
- Preload bridge: drop `getRuntimeFlags` from the `app` IPC surface.

### 4. Settings UI

- `src/renderer/src/components/settings/ExperimentalPane.tsx` — remove the entire "Detailed agent activity" `SearchableSetting` block (lines 125-211), the `showAgentDashboard` local (lines 68-70 — used only as the gate around the deleted block), the `agentDashboardEnabledAtStartup` state, the `useEffect` that fetches runtime flags, the `pendingAgentDashboardRestart` derived state, the `handleRelaunch` callback, the `relaunching` state, and the `toggleWorktreeCardProperty` import (if no other use remains).
- `src/renderer/src/components/settings/experimental-search.ts` — keep `EXPERIMENTAL_PANE_SEARCH_ENTRIES[0]` in place but add a comment that index 0 is preserved as a placeholder so the numeric-index references in `ExperimentalPane.tsx` (`[1]` → Mobile, `[2]` → Sidekick, `[3]` → Orchestration, `[4]` → Worktree symlinks) don't shift. Mark it clearly as unused.

### 5. Renderer feature gates (delete)

All of these can have their `experimentalAgentDashboard` checks deleted:

- `src/renderer/src/App.tsx:152, 933` — drop the gate around `<RetainedAgentsSyncGate />`. Mount unconditionally.
- `src/renderer/src/components/sidebar/WorktreeCard.tsx:57-59, 580` — render the inline agents block whenever `cardProps.includes('inline-agents')`.
- `src/renderer/src/components/sidebar/SidebarHeader.tsx:65-68` — always include the `'inline-agents'` checkbox in `visiblePropertyOptions`.
- `src/renderer/src/components/sidebar/visible-worktrees.ts:181-182` and `WorktreeList.tsx:639-640` — pass `state.agentStatusByPaneKey` to smart sort unconditionally.
- `src/renderer/src/components/sidebar/useWorktreeAgentRows.ts:37, 89-91` — drop the early return.
- `src/renderer/src/components/dashboard/useDashboardData.ts:160, 173-175` — drop the early return.
- `src/renderer/src/components/dashboard/useRetainedAgents.ts:16, 29-40` — drop the disabled branch (and its `prevAgentsRef` reset).
- `src/renderer/src/components/terminal-pane/pty-connection.ts:364-366` — drop the per-event guard.
- `src/renderer/src/hooks/useIpcEvents.ts:810-812` — drop the per-event guard.
- `src/renderer/src/hooks/useAutoAckViewedAgent.ts:134-136` — drop the early return.

Several comments inside these files still cite `experimentalAgentDashboard` as the rationale; update them in the same pass — the full list lives in checklist step 6.

### 6. Telemetry

- `src/shared/telemetry-events.ts:133` — remove `experimentalAgentDashboard` from `SETTINGS_CHANGED_WHITELIST`. Verify `config/scripts/verify-telemetry-constants.mjs` still passes; no `settings_changed` events for this key will be emitted because `src/main/ipc/settings.ts` won't have a setting key to track.

### 7. Tests

- `src/main/codex-accounts/service.test.ts:92`, `src/main/codex-accounts/runtime-home-service.test.ts:98` — remove the `experimentalAgentDashboard` field from mock settings if the field is removed from `GlobalSettings`. (If we keep it as deprecated, leave the mocks alone.)
- `src/main/persistence.test.ts:612-701` — rewrite per §1.

## SSH (handled separately)

Tracked and being implemented in a different workspace. **Out of scope for this branch.**

Context (so reviewers don't re-raise): the agent hook server binds to `127.0.0.1` and managed hook installation runs against the local `homedir()`. SSH-spawned agents on the remote host won't have the managed hooks installed and won't produce `agentStatus:set` events — so inline agent rows for SSH worktrees stay empty in this PR. That's not a regression (they were empty before too); the SSH workspace owns the fix.

## Cross-platform

No platform-specific changes. The hook installer paths and the local server already work on macOS/Linux/Windows. Removing the gates does not introduce any new OS-conditional code paths.

## Rollback

Re-adding the gate requires restoring three layers:

1. **Setting + default**: `experimentalAgentDashboard: boolean` in `GlobalSettings` (`src/shared/types.ts`) and the `false` default in `src/shared/constants.ts`.
2. **Gates**: the consuming sites listed in §2 and §5 (main process gate around `agentStatus:set`, the managed-hook install wrapper, and every renderer early-return / conditional render).
3. **Runtime-flag plumbing for the toggle UX**: `AppRuntimeFlags` + `runtimeFlags` + `setAppRuntimeFlags` + the `app:getRuntimeFlags` handler in `src/main/ipc/app.ts`, the `agentDashboardEnabledAtStartup` field in `src/preload/api-types.ts`, the preload bridge exposure in `src/preload/index.ts`, the `setAppRuntimeFlags(...)` call at startup in `src/main/index.ts`, and the full "Detailed agent activity" `SearchableSetting` block in `ExperimentalPane.tsx`.

No data migrations are destructive: the `_inlineAgentsDefaultedForExperiment` flag stays around either way, persisted `'inline-agents'` entries in `worktreeCardProperties` are harmless when the gate is back, and the persisted `experimentalAgentDashboard` key (if it survived from a pre-removal install) round-trips through the merge — restoring the field type re-exposes the value automatically.

## Out of scope

- Reworking the inline agents UI / data model.
- SSH support (handled in a separate workspace).
- Removing the hidden experimental group or other unrelated experimental settings.

## Branch checklist

Concrete steps to get `brennanb2025/agent-status-on` ready to ship. Order matters where noted; everything else is independent.

### Code changes

1. **Persistence migration (do first; everything else depends on the field/flag still being readable until the renderer/main gates are gone).**
   - `src/main/persistence.ts:191-211` — drop the `experimentOn` predicate so `needsInlineAgentsMigration` becomes `!inlineAgentsMigrated && Array.isArray(rawCardProps) && !rawCardProps.includes('inline-agents')`. Keep stamping `_inlineAgentsDefaultedForExperiment: true`. Update the comment to explain it now fires for everyone.

2. **Main process: install hooks unconditionally + drop runtime-flag plumbing.**
   - `src/main/index.ts:285` — drop the `if (store?.getSettings().experimentalAgentDashboard === true)` gate around the `agentStatus:set` send.
   - `src/main/index.ts:448-472` — remove the `agentDashboardEnabled` const and the `if (agentDashboardEnabled)` wrapper; install Claude/Codex/Gemini managed hooks unconditionally inside the existing fail-open try/catch loop. Update the surrounding comment.
   - `src/main/index.ts:550-552` — delete the `setAppRuntimeFlags(...)` call.
   - `src/main/ipc/app.ts:9-29` — delete `AppRuntimeFlags`, the module-level `runtimeFlags`, `setAppRuntimeFlags`, and the `app:getRuntimeFlags` IPC handler. Drop the now-unused import in `index.ts:15`.

3. **Preload bridge.**
   - `src/preload/api-types.ts:346` — drop `agentDashboardEnabledAtStartup` (and the surrounding type if it becomes empty).
   - Drop the `getRuntimeFlags` exposure in the preload `app` namespace (whichever file wires `window.api.app.getRuntimeFlags`).

4. **Renderer: delete every gate.**
   - `src/renderer/src/App.tsx:152, 933` — drop the `agentDashboardEnabled` selector and unwrap `<RetainedAgentsSyncGate />` so it always mounts.
   - `src/renderer/src/components/sidebar/WorktreeCard.tsx:57-59, 580` — delete `dashboardExperimentEnabled`; render the inline block whenever `cardProps.includes('inline-agents')`.
   - `src/renderer/src/components/sidebar/SidebarHeader.tsx:65-68` — drop `liveAgentsEnabled` and inline `PROPERTY_OPTIONS` directly into the dropdown; the `'inline-agents'` checkbox is always shown.
   - `src/renderer/src/components/sidebar/visible-worktrees.ts:181-182` — pass `state.agentStatusByPaneKey` to `sortWorktreesSmart` directly.
   - `src/renderer/src/components/sidebar/WorktreeList.tsx:639-640` — same: drop the conditional, pass the map directly to `buildExplicitEntriesByTabId` and `computeSmartScore`.
   - `src/renderer/src/components/sidebar/useWorktreeAgentRows.ts:37, 89-91` — drop `dashboardEnabled` and the `EMPTY_ROWS` early return; remove `EMPTY_ROWS` if it has no other use.
   - `src/renderer/src/components/dashboard/useDashboardData.ts:160, 173-175` — drop `dashboardEnabled` and the disabled branch.
   - `src/renderer/src/components/dashboard/useRetainedAgents.ts:16, 29-40` — drop `dashboardEnabled` and the entire disabled branch (including the `prevAgentsRef.current = new Map()` reset).
   - `src/renderer/src/components/terminal-pane/pty-connection.ts:364-366` — drop the per-event guard.
   - `src/renderer/src/hooks/useIpcEvents.ts:810-812` — drop the per-event guard.
   - `src/renderer/src/hooks/useAutoAckViewedAgent.ts:134-136` — drop the early return; the surrounding `lastSettings` short-circuit is fine to leave alone.

5. **Settings UI.**
   - `src/renderer/src/components/settings/ExperimentalPane.tsx:125-211` — delete the entire "Detailed agent activity" `SearchableSetting` block, the `showAgentDashboard` local at lines 68-70 (used only as that block's render gate), plus the `agentDashboardEnabledAtStartup` state, the `useEffect` that calls `getRuntimeFlags`, `pendingAgentDashboardRestart`, `handleRelaunch`, and the `relaunching` state. Drop the now-unused `RotateCw` import and `Button` import (verify others don't still need them — `Button` is used elsewhere). Drop the `toggleWorktreeCardProperty` and `useAppStore` imports if no other use remains.
   - `src/renderer/src/components/settings/experimental-search.ts` — keep `EXPERIMENTAL_PANE_SEARCH_ENTRIES[0]` in place so the numeric-index references in `ExperimentalPane.tsx` (`[1]` Mobile, `[2]` Sidekick, `[3]` Orchestration, `[4]` Worktree symlinks) don't shift. Add a one-line comment marking entry 0 as a preserved placeholder for the removed agent-dashboard toggle.

6. **Type + default cleanup (do this last; nothing should still reference the field by the time it's removed).**
   - `src/shared/types.ts:1217` — remove `experimentalAgentDashboard` from `GlobalSettings`.
   - `src/shared/constants.ts:203` — remove the `experimentalAgentDashboard: false` default.
   - `src/shared/telemetry-events.ts:133` — remove `experimentalAgentDashboard` from `SETTINGS_CHANGED_WHITELIST`.
   - `src/shared/agent-hook-types.ts:26` — update the comment that references the experimental gate; the protocol-version rationale still holds (no shipped fleet yet, Cursor scripts rewritten), but the wording needs to reflect default-on.
   - **Stale-comment sweep.** After the field is gone, several explanatory comments still cite it. Update or remove:
     - `src/shared/types.ts:1388-1396` — JSDoc on `_inlineAgentsDefaultedForExperiment` describes the migration as experiment-gated; rewrite to reflect "fires once for every user on first upgrade."
     - `src/renderer/src/components/dashboard/RetainedAgentsSyncGate.tsx:11-13` — comment claims hooks inside early-return when the setting is off; that's no longer true. Either delete the comment or replace with a one-liner explaining the gate's remaining purpose.
     - `src/renderer/src/App.tsx:175-179, 920-933` — comments around the (now-removed) `agentDashboardEnabled` gate.
     - `src/main/index.ts:448-452, 554-559` — comment above the managed-hook install loop and above `agentHookServer.start` reference the experiment.
     - `src/renderer/src/hooks/useAutoAckViewedAgent.ts:103-107` — `Why:` comment about flipping the setting; the surrounding `lastSettings` short-circuit can stay, but its rationale needs a rewrite.
     - `src/renderer/src/hooks/useIpcEvents.ts:800-806` — comment explains the per-event guard; once the guard is gone, the comment should be deleted (the unconditional subscription is the whole story).
     - `src/renderer/src/components/terminal-pane/pty-connection.ts:358-362` — same pattern: the OSC 9999 drop-before-store comment becomes inaccurate; delete or rewrite.

### Tests

7. **Persistence tests** — `src/main/persistence.test.ts:612-701`:
   - Rewrite "adds inline-agents to persisted cardProps when experimental toggle is on" → "adds inline-agents to persisted cardProps on first load after upgrade" (no `settings: { experimentalAgentDashboard: true }`).
   - Delete "does not add inline-agents when experimental toggle is off" — that branch no longer exists.
   - Keep "respects a deliberate uncheck after migration flag is set" — drop the `experimentalAgentDashboard` field from the `settings` block.
   - Keep "leaves cardProps alone when inline-agents is already present" — drop the `experimentalAgentDashboard` field.

8. **Mock-settings cleanup** — drop `experimentalAgentDashboard` from:
   - `src/main/codex-accounts/service.test.ts:92`
   - `src/main/codex-accounts/runtime-home-service.test.ts:98`

### Verification

9. Run typecheck — `pnpm typecheck` (or whatever the project uses) — to catch any straggler references.
10. Run unit tests: `pnpm test` (focus on `persistence.test.ts`).
11. Run `config/scripts/verify-telemetry-constants.mjs` to confirm the whitelist edit is consistent.
12. Manual smoke test: launch fresh, run a Claude / Codex / Gemini agent in a local worktree, confirm inline agent rows appear without flipping any setting. Confirm the Experimental settings pane no longer lists "Detailed agent activity".
13. Regression check: SSH worktree opens cleanly, inline agents stay empty (no console errors, no empty-state crash). No SSH UI message in this PR.

### Commit / PR

14. Single commit (or a small focused series): "feat(agent-dashboard): default-on, remove experimental toggle".
15. PR body should call out the user-global config mutation (managed hook install now runs for all users on first launch) and link this design doc.
