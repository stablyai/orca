# The `ui` / `settings` / `session` Hybrid Storage Mechanisms (web build)

These three `window.api` namespaces carry the **bulk** of Orca's UI state,
preferences, and workspace-session data. On desktop they're pure Electron
IPC to a disk-backed main process. On the **web build** (no Electron main
process to talk to), each falls back to a `localStorage`-backed cache with
its own merge/reconciliation strategy — and the three differ sharply in how
much of that data actually reaches the backend. All file references below
are `frontend/src/renderer/src/web/web-preload-api.ts` unless noted.

## `ui` namespace

**localStorage key:** `orca.web.ui.v1` (`UI_STORAGE_KEY`, line 148).

**Data shape:** the full `PersistedUIState` object (`frontend/src/shared/types.ts:3315`
desktop / `:3348` web copy) — an ~80-field object covering UI chrome and
view-state: `activeView`, `sidebarWidth` (default 280),
`rightSidebarOpen`/`rightSidebarTab`/`rightSidebarWidth`,
`markdownTocPanelWidth`, `groupBy`/`sortBy`/`projectOrderBy`,
`hideSleepingWorkspaces`, `workspaceHostScope`/`visibleWorkspaceHostIds`/
`workspaceHostOrder`, `filterRepoIds`/`collapsedGroups`,
`uiZoomLevel`/`editorFontZoomLevel`, `worktreeCardProperties` (which
metadata badges show on workspace cards), `agentActivityDisplayMode`,
`workspaceStatuses`/`workspaceBoardOpacity`/`workspaceBoardColumnWidth`,
`statusBarItems`/`statusBarVisible`, `usagePercentageDisplay`,
`dismissedUpdateVersion`, `windowBounds`/`windowMaximized`,
`featureInteractions` (per-feature first-use/interaction-count telemetry),
`contextualToursSeenIds`, plus a long tail of one-shot
`_xyzMigrated`/`_xyzDefaulted` migration-guard booleans. Defaults come from
`getDefaultUIState()` (`agent/src/shared/constants.ts:466`).

**Write/read triggers** (`createWebUiApi`, line 2637):
- `ui.get()` (2640-2665): calls RPC `ui.get`, merges the result over the
  local copy, writes back to `UI_STORAGE_KEY` (2659). On RPC failure/offline,
  falls back to `readLocalWebUIState()` (2663) with no write.
- `ui.set(updates)` (2666-2675): writes the merged state to localStorage
  **synchronously, immediately** (optimistic, 2668) *before* the RPC call;
  fires RPC `ui.set`; a failure is silently swallowed (2672-2674 — "unpaired/
  offline web clients still need local UI persistence").
- `ui.recordFeatureInteraction(id)` (2676-2714): optimistically writes an
  updated `featureInteractions` map first (2689), then calls the RPC; on
  success overwrites local storage with the server's authoritative merge
  (2708), on failure keeps the optimistic value.
- `readLocalWebUIState()` (3774-3795): reads `UI_STORAGE_KEY` via generic
  `readJson` (4119-4129), layers `getDefaultUIState()` defaults, recomputes
  `worktreeCardProperties` from current settings when absent.

**Merge algorithm:** `mergeWebUIState(base, updates)` (3797-3821) — a
shallow spread (`{...base, ...safeUpdates}`, last-write-wins per top-level
key), with custom reconciliation for `worktreeCardProperties`
(renormalized via `normalizeWorktreeCardProperties`,
`agent/src/shared/worktree-card-properties.ts:55-66`), `undefined`-safe
fallback for `_worktreeCardModeDefaulted`/`agentActivityDisplayMode`/
`usagePercentageDisplay`, and an explicit strip of
`featureInteractionTelemetryBuckets` (3801-3805, "reserved" no-op field).
`featureInteractions`/`contextualToursSeenIds` merge via dedicated
`mergeFeatureInteractionState`/`mergeContextualTourSeenIds` calls (2650-2657,
2699-2706) rather than the shallow spread. **Pattern: optimistic local
write, then reconcile with server's authoritative state on every successful
RPC round-trip; pure local persistence with no reconciliation when
offline/unpaired.**

**Backend RPC counterpart:** `backend/src/main/runtime/rpc/methods/client-ui.ts:10-47`
(`CLIENT_UI_METHODS`) — `ui.get` (28-31) → `runtime.getUIState()`, `ui.set`
(33-39) → `runtime.updateUIState(params)`, `ui.recordFeatureInteraction`
(40-46) → `runtime.recordFeatureInteraction(params)`. These map through
`OrcaRuntimeService` (`backend/src/main/runtime/orca-runtime.ts:471-491`) to
`Store.getUI()`/`updateUI()`/`recordFeatureInteraction()`
(`backend/src/main/persistence.ts:~5367,~5415`). **The backend stores and
returns the entire `PersistedUIState` object — no field allowlist**, unlike
`settings` below.

**Data-loss-if-cleared:** For a **paired** client this is a genuine
**cache** — the full state round-trips through the backend's disk file (see
`session` section), so clearing `orca.web.ui.v1` just forces a re-fetch. For
an **unpaired/offline** web client, localStorage is the only copy — clearing
it silently resets all UI/view preferences to defaults (convenience loss
only, not user content).

## `settings` namespace

**localStorage key:** `orca.web.settings.v1` (`SETTINGS_STORAGE_KEY`, line 147).

**Data shape:** `GlobalSettings` (`frontend/src/shared/types.ts:2524`,
~200+ fields) — Orca's entire preferences surface: `workspaceDir`, `theme`,
`leftSidebarAppearanceMode`, `uiLanguage`, `appIcon`/`appFontFamily`, the
full terminal appearance/behavior block (`terminalFontSize`,
`terminalCursorStyle`, `terminalThemeDark/Light`, `terminalCustomThemes`,
`terminalGpuAcceleration`, scrollback rows, ...), `notifications`,
`diffDefaultView`, `sourceControlViewMode`, agent-related fields
(`defaultTuiAgent`, `disabledTuiAgents`, `agentDefaultArgs/Env`,
`codexManagedAccounts`, `claudeManagedAccounts`), `httpProxyUrl`,
`webPushSubscriptions`, `vapidKeys`, `githubProjects`, `commitMessageAi`,
`voice`, plus many one-shot migration-guard booleans. Defaults from
`getDefaultSettings(homedir)` (`agent/src/shared/constants.ts:189-408`).

**Write/read triggers** (lines 596-618):
- `settings.get` (597) → `getRuntimeBackedStoredSettings()` (async, RPC-backed).
- `settings.getSync` (598-600) → `getStoredSettings()`, a **synchronous**
  localStorage-only read for "the pre-hydration kill-switch read [to] work
  the same as desktop" (comment, 598-599). Implementation (3555-3596): reads
  `SETTINGS_STORAGE_KEY` directly via `window.localStorage.getItem`, applies
  one-shot migrations, layers `getDefaultSettings('~')` under it.
- `settings.set(updates)` (601-614): merges into local storage
  synchronously via `mergeSettings` + `writeJson(...)` (609-612) **first**,
  then calls `syncRuntimeBackedSettings(updates, next)` (613) to push to the
  backend.
- `settings.updatePRBotAuthorOverride` (615) → same optimistic-local-then-RPC
  pattern (3680-3708).

**Merge algorithm:** `mergeSettings(base, updates, options)` (3860-3900) —
shallow spread (last-write-wins) with nested-merge special cases for
`notifications`/`githubProjects`/`voice`, array-normalizers for
`disabledTuiAgents`/`agentDefaultArgs`/`agentDefaultEnv`/`terminalCustomThemes`,
and a final re-application of `normalizeAutoRenameBranchFromWorkDefaultOn`
(`agent/src/shared/auto-rename-branch-from-work-settings.ts:8-21`).

**Backend RPC counterpart — narrow allowlist, NOT a full sync:**
`client-ui.ts:11-27` defines `settings.get`/`settings.update`/
`settings.updatePRBotAuthorOverride`, routed through
`runtime.getClientSettings()`/`updateClientSettings()`/
`updateClientPRBotAuthorOverride()`
(`backend/src/main/runtime/orca-runtime.ts:493-602`).
**`getClientSettings()` returns only a fixed 17-field `Pick<GlobalSettings,…>`
projection** (`defaultTuiAgent`, `disabledTuiAgents`, `agentCmdOverrides`,
`agentDefaultArgs`, `agentDefaultEnv`, `agentStatusHooksEnabled`,
`defaultTaskSource`, `defaultTaskViewPreset`, `visibleTaskProviders`,
`defaultRepoSelection`, `defaultLinearTeamSelection`, `githubProjects`,
`experimentalNewWorktreeCardStyle`, `compactWorktreeCards`,
`minimaxGroupId`, `minimaxUsageModels`, `prBotAuthorOverrides` — lines
493-512), backed by `Store.getSettings()`/`updateSettings()`
(`backend/src/main/persistence.ts:5135,5216`), which persists the *entire*
`GlobalSettings` to disk for desktop. **The web client's write side mirrors
this narrowness independently**: `getRuntimeBackedStoredSettings()`
(3598-3635) and `syncRuntimeBackedSettings()` (3637-3678) each hand-pick only
~5 fields (`experimentalNewWorktreeCardStyle`, `compactWorktreeCards`,
`minimaxGroupId`, `minimaxUsageModels`, `prBotAuthorOverrides`) to send/
receive over RPC.

> **Standout finding**: everything else in `GlobalSettings` — all terminal
> appearance, theme, proxy, notification, and default-agent settings —
> **never leaves the browser** for a web client.

**Data-loss-if-cleared — mixed, and the biggest gap found in this audit:**
the ~5 RPC-synced fields are true caches of backend-disk-persisted data
(safe to clear). The remaining ~195 fields have **no RPC sync path for the
web client at all** — `orca.web.settings.v1` is their **sole copy** in a
browser session. Clearing localStorage on a paired web client silently
resets nearly all preferences to defaults, with no way to recover them from
the backend even though the desktop/backend `Store` may hold a fuller
`GlobalSettings` for its own local UI.

## `session` namespace

**Correction to a common assumption**: `session` here is **not** auth/login
session data — it's `WorkspaceSessionState`
(`frontend/src/shared/types.ts:1077-1141`): open terminal tabs, split-pane
layouts, active repo/worktree/tab IDs, editor files open at shutdown,
browser tabs/pages, PTY↔tab bindings, terminal scrollback references, etc.
Auth for the paired-WS connection itself is a separate cookie-based
`WsSessionRouter` (`desktop/src/main/session/ws-session-router.ts:19-190`),
unrelated to `window.api.session`.

**localStorage key(s):** `orca.web.workspaceSession.v1`
(`SESSION_STORAGE_KEY`, line 149). Non-local execution hosts get a
**suffixed** key `${SESSION_STORAGE_KEY}.${hostId}` via
`sessionStorageKeyForHost()` (3730-3735), so remote/SSH-host session state
never clobbers the local partition.

**Data shape:** `WorkspaceSessionState` — `activeRepoId`/`activeWorktreeId`/
`activeTabId`, `tabsByWorktree: Record<string, TerminalTab[]>`,
`terminalLayoutsByTabId`, `openFilesByWorktree`,
`browserTabsByWorktree`/`browserPagesByWorkspace`,
`unifiedTabs`/`tabGroups`/`tabGroupLayouts`, `lastVisitedAtByWorktreeId`,
`sleepingAgentSessionsByPaneKey`, etc. (full list at
`frontend/src/shared/types.ts:1077-1139`). Defaults from
`getDefaultWorkspaceSession()` (`agent/src/shared/constants.ts:533`).

**Write/read triggers — web build is PURE localStorage, no RPC at all**
(lines 653-674):

```ts
session: {
  get: (hostId) => Promise.resolve(getStoredWorkspaceSession(hostId)),
  set: async (session, hostId) => { writeJson(sessionStorageKeyForHost(hostId), sanitizeWebRuntimeWorkspaceSession(session)) },
  patch: async (patch, hostId) => { writeJson(sessionStorageKeyForHost(hostId), sanitizeWebRuntimeWorkspaceSession({...getStoredWorkspaceSession(hostId), ...patch})) },
  readTerminalScrollback: () => null,
  setSync: (session, hostId) => { writeJson(sessionStorageKeyForHost(hostId), sanitizeWebRuntimeWorkspaceSession(session)) }
}
```

None of `get`/`set`/`patch`/`setSync` call the RPC layer — every operation
is a direct `window.localStorage` read/write. `getStoredWorkspaceSession()`
(3737-3759) does overlay `activeRepoId`/`activeWorktreeId` from the
(backend-synced) `ui` state when a runtime environment is paired
(3750-3757: "paired web clients mirror host session-tabs after startup...
Replaying browser-local terminal handles first creates stale remote PTYs"),
but `tabsByWorktree`, `terminalLayoutsByTabId`, and everything else stay
browser-local even when paired.

**Merge algorithm:** simple `{...current, ...patch}` shallow merge for
`patch` (664-667); `set`/`setSync` are full overwrites. No optimistic-vs-
reconcile flow exists — there's no RPC leg to reconcile against.

**Backend/desktop counterpart — disk-backed, genuinely different backing
store:** the Electron desktop IPC layer exposes `session:get`/`session:set`/
`session:patch`/`session:set-sync` channels
(`desktop/src/main/ipc/session.ts:6-59`) to `Store.getWorkspaceSession()`/
`setWorkspaceSession()`/`patchWorkspaceSession()`
(`desktop/src/main/persistence.ts:5515-5733`), which schedule a debounced
(1s trailing / 5s max-wait) async write of the **entire `PersistedState`
blob** — `ui`, `settings`, and `workspaceSession` all together — to a single
JSON file on disk at `<Electron userData dir>/orca-data.json` (path resolved
in `backend/src/main/persistence-paths.ts:20-42`; `ORCA_DATA_DIR` env var
overrides it), via `writeToDiskAsync()`/`scheduleSave()`
(`backend/src/main/persistence.ts:3531-3557`) with backup rotation
(`.bak.0`..`.bak.N`). `session:set-sync` is a **synchronous** IPC call
(`ipcMain.on`, not `.handle`) used from the renderer's `beforeunload`
handler to guarantee the flush completes before the window closes
(`desktop/src/main/ipc/session.ts:22-25`).

**Data-loss-if-cleared**: `orca.web.workspaceSession.v1` is the **sole
copy** of workspace/terminal-tab state for the web build — clearing it
loses all open tabs, split layouts, and per-worktree editor/browser state,
with no backend fallback (only `activeRepoId`/`activeWorktreeId` can be
partially recovered from the paired backend's `ui` state). On desktop, the
equivalent data goes to `orca-data.json` on local disk instead — a
genuinely different backing store, but still device-local, not
server/cloud-durable; it merely survives a *browser* cache clear because
it's not in the browser at all.

## Cross-cutting notes

- Generic helpers `readJson<T>(key, fallback)` / `writeJson<T>(key, value)`
  (4119-4133) back all three mechanisms; `readJson` shallow-spreads the
  fallback under whatever JSON parses (or just the fallback on parse
  failure/absence).
- Adjacent keys in the same file, same pure-localStorage pattern as
  `session`: `ONBOARDING_STORAGE_KEY = 'orca.web.onboarding.v1'` (line 150),
  `GITHUB_CACHE_STORAGE_KEY = 'orca.web.githubCache.v1'` (line 151),
  `KEYBINDINGS_STORAGE_KEY` used by `createWebKeybindingsApi()`
  (1085-1111).
- `frontend/src/renderer/src/store/slices/settings.ts` and the app store
  call `window.api.settings.get/getSync/set` and `window.api.ui.get/set`
  exactly per the contract above — no separate parallel-shape definition
  exists in the slice; it consumes the shared `frontend/src/shared/types.ts`
  types directly.
- `WebSessionClient` (`frontend/src/renderer/src/web/web-session-client.ts:44`)
  is the WS RPC transport used when a paired environment uses cookie-based
  session auth instead of E2EE pairing (3477-3500); it carries `ui.*`/
  `settings.*` RPC traffic but is not itself a storage mechanism for
  `window.api.session`.
