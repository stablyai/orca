# Backend-Persisted Frontend State

Feature-by-feature inventory of what frontend (renderer) state is persisted
to a backend — either the local Electron main-process `Store`
(`backend/src/main/persistence.ts`, mostly a JSON blob in Postgres, plus a
documented set of genuinely relational tables), or a remote/cloud service
(GitHub, Jira, Linear, the Orca auth server) — as opposed to being purely
client-side (see [`browser-storage.md`](./browser-storage.md)) or ephemeral
(lost on restart).

**Architecture note** (confirmed from `specs/frontend/api/*.md`): the
Zustand store has **no** localStorage-persist middleware. Anything that
survives an app restart goes through either:

- `window.api.*` (Electron IPC to the main/backend process), or
- `callRuntimeRpc()` (JSON-RPC over WebSocket to `OrcaRuntimeRpcServer`, used
  when the target worktree/environment is remote — SSH or a Dev Server
  Agent),

landing in one of:

1. `backend/src/main/persistence.ts`'s `Store` — mostly **one JSON blob per
   `(tenant_id, user_id)`** in Postgres table `core.orca_data_state_blob`,
   except a documented set of genuine relational tables
   (`orca_ai_provider_accounts`, `orca_users`/`orca_companies`/
   `orca_departments`, `orca_v5_projects`, `orca_teams`, `orca_tasks*`,
   `orca_workflow_*`, `orca_annotations`, `orca_orchestration_*`);
2. a remote third-party/backend service (GitHub/GitLab CLI, Jira REST,
   Linear GraphQL, the Orca auth server);
3. a local desktop-only file outside the blob (`~/.orca/keybindings.json`,
   Claude/Codex/OpenCode usage JSON cache, `.enc` credential files, Electron
   `persist:` browser partitions); or
4. nothing at all (pure runtime state).

> **Reconciliation note (important caveat):** the phrase "Postgres blob"
> below is drawn from `specs/frontend/api/*.md`, which documents a
> multi-tenant/server deployment of this backend. A direct code trace of the
> **Electron desktop** path (see [`ui-settings-session-hybrid.md`](./ui-settings-session-hybrid.md))
> found that `backend/src/main/persistence.ts`'s `Store` actually writes the
> whole `ui`/`settings`/`workspaceSession` state as **one JSON file on local
> disk** (`<Electron userData dir>/orca-data.json`, debounced + backup-rotated),
> not Postgres, for a single-user desktop install. The same `Store`
> abstraction is backed by Postgres in the multi-tenant/team-server
> deployment mode (confirmed separately for usage-tracking: `JsonFileUsageStatePersistence`
> on desktop vs. a swappable Postgres-backed persistence in server mode).
> Read every "Postgres blob" below as "the Electron main-process `Store`,
> whose backing medium — local JSON file vs. Postgres — depends on
> deployment mode," not as a claim that desktop installs talk to Postgres
> directly. See [`feature-persistence-matrix.md`](./feature-persistence-matrix.md)
> for a slice-by-slice re-derivation of the same facts by direct grep
> evidence (file:line), which independently arrived at "disk-backed Electron
> IPC" for `settings`/`keybindings`/`ui`/`session`.

See also: [`specs/frontend/api/README.md`](../api/README.md),
[`backend-agent-execution-boundary.md`](../api/backend-agent-execution-boundary.md),
[`rpc-catalog.md`](../api/rpc-catalog.md), [`ipc-surface.md`](../api/ipc-surface.md),
[`http-endpoints.md`](../api/http-endpoints.md) for the full RPC/IPC/HTTP catalogs
this document draws on.

---

## 1. Worktrees & worktree metadata (diff comments, pinned state, nav history)

- **Persisted?** Mixed — worktree metadata: **Yes** (local backend/Postgres blob). Nav history: **No** (ephemeral).
- **Mechanism**: `store/slices/worktrees.ts` calls `window.api.worktrees.updateMeta`/`updateLineage`/`create`/`remove`/`listLineage` (local) or `callRuntimeRpc(target, 'worktree.set'/'worktree.updateLineage', ...)` (remote). `store/slices/diffComments.ts`'s `persist()` helper does the identical dual-path write: `window.api.worktrees.updateMeta({ worktreeId, updates: { diffComments } })` locally, `callRuntimeRpc(target, 'worktree.set', { worktree, diffComments })` remotely.
- **Data shape**: worktree metadata row (pin state, sortOrder, lineage, diffComments array) inside the Postgres blob. `worktree.lineageList` additionally reads the genuinely relational `PgOrchestrationDb`.
- **Nuance**: `store/slices/worktree-nav-history.ts` has zero persistence import — it's a pure in-memory back/forward stack (max 50 entries), lost on restart. `worktree.set`/`persistSortOrder`/`forgetLocal` are always-local (never relay to a Dev Server Agent even for remote-hosted worktrees).

## 2. Terminal sessions/PTY state, tabs & tab groups/layout

- **Persisted?** Yes (local backend/Postgres blob), with a live-only exception.
- **Mechanism**: `store/slices/tabs.ts`'s `hydrateTabsSession()` and `store/slices/terminals.ts`'s `hydrateWorkspaceSession()` are populated from `window.api.session.get()` at boot (`App.tsx`, `fetchWorkspaceSessionWithRuntimeHostOwners`), and writes go back via `window.api.session.set/patch`. `backend/src/main/persistence.ts` owns `WorkspaceSessionState`. Terminal tab pin/viewMode mirror to a remote host via `setWebRuntimeTabProps` → `session.tabs.setTabProps` RPC when the worktree is runtime-environment-owned.
- **Data shape**: `tabsByWorktree`, `unifiedTabsByWorktree`, `tabGroupLayouts` (split-pane tree), MRU order, terminal tab pin/color/viewMode, `activeWorktreeIdsOnShutdown`.
- **Nuance**: actual PTY *processes* are never persisted (`node-pty`/SSH/Dev-Server-daemon are live OS processes); only the tab/session bookkeeping survives restart. Scrollback: `window.api.session.readTerminalScrollback({ ref })` reads a local on-disk history dir (`backend/src/main/terminal-scrollback-snapshots.ts`) for cold-restore, not the Postgres blob.

## 3. Settings & keybindings

- **Persisted?** Yes — settings: local backend/Postgres blob. Keybindings: local desktop file (not Postgres).
- **Mechanism**: `store/slices/settings.ts` calls `window.api.settings.get()`/`window.api.settings.set(updates)` → `backend/src/main/persistence.ts` blob (`settings.*` namespace). `store/slices/keybindings.ts` calls `window.api.keybindings.ensureFile/get/setAction/reload/openFile/revealFile` → `desktop/src/main/keybindings/keybinding-file.ts`, which reads/writes a plain JSON file at `~/.orca/keybindings.json`.
- **Data shape**: settings = `GlobalSettings` object (UI prefs, feature flags, `activeRuntimeEnvironmentId`, etc.); keybindings = per-action key overrides, versioned file format with per-platform sections.
- **Nuance**: on the **web** build, `settings`/`ui` also layer a localStorage-backed optimistic-merge/offline cache around the same RPC (see [`browser-storage.md`](./browser-storage.md) §1) — that cache is a convenience layer, not the source of truth.

## 4. Auth / session (OrcaUser, AuthStatus)

- **Persisted?** Yes (remote service — backend's own auth/session system), not through the JSON blob.
- **Mechanism**: `store/slices/auth.ts` is a pure state container (no RPC calls itself). It's populated by `web/main-web-bootstrap.tsx` from `sessionUser` (resolved via `GET /auth/me`, an HttpOnly `orca_session` cookie), calling `store.setCurrentUser()`/`setAuthStatus('authenticated')`. Login is `POST /auth/local`; logout `POST /auth/logout`.
- **Data shape**: `OrcaUser` (id/email/name/avatarUrl/teams/projects/role) backed by the relational `orca_users` table.
- **Nuance**: the Zustand copy itself isn't persisted client-side — it's re-derived every launch from the session cookie; if the cookie/session is gone, `authStatus` reverts to `unauthenticated`. See [`browser-storage.md`](./browser-storage.md#authsession-token-storage) for confirmation that no token is ever put in Web Storage.

## 5. SSH / dev-server / runtime-environment connections

- **Persisted?** Mixed — SSH targets/dev servers: Yes (local backend/Postgres blob). Live connection state: No (ephemeral, explicitly documented as runtime-only).
- **Mechanism**: `store/slices/ssh.ts` and `runtime-environment-ssh.ts` hold no direct API calls (pure Map-based state + `ssh-target-cleanup.ts` reconciliation helpers). The actual CRUD/read runs through `runtime/runtime-ssh-client.ts`: `window.api.ssh.listTargets()`/`getState()`/`connect()` locally, or `callRuntimeRpc(target, 'ssh.listTargets'|'ssh.connect', ...)` remotely. `devServer.list/add/remove` are Postgres CRUD (`DevServerStore`).
- **Data shape**: `SshTarget[]` (host/port/user/key config) in the blob; `SshConnectionState` (connected/connecting/error) is pure in-memory (`SshConnectionManager`) — connection status is explicitly not persisted (runtime-only).
- **Known gap**: `devServer.listSshTargets`/`addSshTarget` is flagged elsewhere as likely broken (constructs `SshConnectionStore` with a missing required constructor arg) — noted here for completeness, not something this audit fixes.

## 6. GitHub integration (PRs, checks, projects, work items cache)

- **Persisted?** Yes (local backend/Postgres blob) as a cache; remote-authoritative data comes from GitHub via the `gh` CLI.
- **Mechanism**: `store/slices/github.ts` debounce-saves `prCache`/`issueCache` via `window.api.cache.setGitHub({ cache: { pr, issue } })`, hydrated at boot via `window.api.cache.getGitHub()` — both trace into `persistence.ts`'s `getGitHubCache()`/`setGitHubCache()` (the blob). Live GitHub data (`gh.listWorkItems`, `gh.prChecks`, `gh.issue`, `gh.updateProjectItemField`, etc.) runs the `gh` CLI in the backend process directly, except `github.startAuthLogin`/`revokeAuth` which do relay.
- **Data shape**: `{ pr: Record<key, {data, fetchedAt}>, issue: Record<key, {data, fetchedAt}> }` — a TTL'd read-through cache, not the primary store of truth.
- **Nuance**: `github-checks.ts`, `github-project-row-owner.ts`, `github-work-items-query-bounds.ts`, `github-cache-key.ts` are pure helper/selector modules with no independent persistence path.

## 7. Jira integration

- **Persisted?** Mixed — Jira data itself: No (remote-authoritative, re-fetched live). Credentials: Yes, but not Postgres.
- **Mechanism**: `store/slices/jira.ts` calls into `runtime/runtime-jira-client.ts`, which calls `callRuntimeRpc(target, 'jira.listIssues'|'searchIssues'|'createIssue'|'connect'|..., ...)`. Backend handles Jira via direct HTTPS REST calls.
- **Data shape**: issues/projects/transitions fetched live each call; credentials stored in an encrypted local file (`~/.orca/jira-*`) or `WebCredentialStore` in multi-user mode — not the Postgres blob.
- **Nuance**: Jira issue data displayed in the UI is always a live snapshot, never durably cached client-side beyond the in-memory slice.

## 8. Linear integration

- **Persisted?** Mixed — same pattern as Jira: issue/project data is No (live), credentials Yes (encrypted file, not Postgres); one side-effect field IS written to the blob.
- **Mechanism**: `store/slices/linear.ts` → `runtime/runtime-linear-client.ts` → `callRuntimeRpc(target, 'linear.listIssues'|'searchIssues'|'connect'|..., ...)`. Backend uses the Linear GraphQL SDK directly.
- **Data shape**: issues/teams/custom views fetched live; credentials in `~/.orca/linear-*` or `WebCredentialStore`.
- **Nuance**: `linear.resolveCurrentIssue` writes `linkedLinearIssueWorkspaceId` onto the worktree's blob row — the one place Linear state does land in Postgres.

## 9. Hosted review

- **Persisted?** Mixed — creation/eligibility: No (live check against GitHub/GitLab/etc.); one stats side-effect: Yes, but to a local JSON file, not Postgres.
- **Mechanism**: `store/slices/hosted-review.ts` calls `window.api.hostedReview.getCreationEligibility/create/forBranch`. Backend routes GitHub/GitLab reviews through the same self-executed CLI path as `github.*`/`gitlab.*`; Bitbucket/Azure DevOps/Gitea go through per-user HTTP clients using `WebCredentialStore` tokens.
- **Data shape**: PR/MR creation result, eligibility flags; `pr_created` stats are appended to a local `orca-stats.json` file (not Postgres).
- **Nuance**: `hosted-review-cache-identity.ts`/`hosted-review-cache-race.test.ts` etc. are cache-key/race-guard helpers around the in-memory slice cache, not a separate durable store.

## 10. Onboarding checklist / feature-wall completion

- **Persisted?** Yes (local backend/Postgres blob).
- **Mechanism**: `store/slices/onboarding-checklist.ts` calls `markRuntimeOnboardingChecklistItem()` (`runtime/runtime-onboarding-client.ts`) → `window.api.onboarding.markChecklistItem/update/get` locally or `callRuntimeRpc(target, 'onboarding.markChecklistItem', ...)` remotely → backed by `persistence.ts`.
- **Data shape**: `OnboardingExtendedChecklistState` — global checklist flags plus `perServer: Record<devServerId, PerServerChecklistState>`.
- **Note**: the *Feature Wall's own* visited/completed-step tracking (a related but separate UI concept) is client-side only — see [`browser-storage.md`](./browser-storage.md) §4.

## 11. Orca profiles (AI provider credentials/config)

- **Persisted?** Yes (local backend/Postgres, relational tables), with a client-encryption nuance for actual credential material.
- **Mechanism**: `store/slices/orca-profiles.ts` imports from `runtime/runtime-orca-profiles-client.ts`, which wraps `window.api.orcaProfiles.*` (local) / `callRuntimeRpc(target, 'orcaProfiles.list'|'authStatus'|'createLocal'|'switch'|'transferProject'|..., ...)` (remote). `store/slices/ai-provider-slice.ts` and `profile-slice.ts` are pure state containers populated by `hooks/useAIProviders.ts` (`aiProvider.*` RPC) and `hooks/useProfile.ts` (`profile.*` RPC).
- **Data shape**: `AIProviderAccount[]`/usage → `orca_ai_provider_accounts`/`orca_provider_usage` tables; `OrcaProfile`/`ResolvedProfile`/`Department` → `orca_users`/`orca_companies`/`orca_departments`/`orca_user_profiles` tables.
- **Nuance**: `aiProvider.writeCredential`/`rotateKey`/`testConnection` are the 3 methods that relay to the Dev Server Agent — only already-client-encrypted ciphertext crosses the wire (ADR-008); the backend Postgres row only ever stores account `status` metadata, never decrypted credentials.

## 12. Remote agent sessions

- **Persisted?** No (ephemeral, in-memory only, rebuilt purely from live push events).
- **Mechanism**: `store/slices/remote-agent-sessions.ts` has zero persistence imports. `components/workspace/AgentPanel.tsx` calls `window.api.agentOrchestration.start/stop/resume` and subscribes to `onStatusChanged` push events, writing directly into `remoteAgentSessions: Record<worktreeId, RemoteAgentSession>`.
- **Data shape**: `{ sessionId, worktreeId, agentType, trustPreset, status, startedAt, stoppedAt?, errorMessage? }`.
- **Nuance**: no hydration/list call was found on mount — a restart loses the frontend's view of which sessions are running entirely (even though the underlying agent session may still be alive server-side); no explicit resync path exists today.

## 13. Rate limits / usage tracking (claude/codex/opencode-usage, rate-limits)

- **Persisted?** Split — usage tracking: Yes (local JSON file on desktop / Postgres in server mode, as a scan cache). Rate limits: No (pure live poll, in-memory only).
- **Mechanism (usage)**: `store/slices/claude-usage.ts`/`codex-usage.ts`/`opencode-usage.ts` call `runtime/runtime-{claude,codex,opencode}-usage-client.ts` → `callRuntimeRpc({kind:'local'}, 'claudeUsage.getSnapshot'|'refresh'|'getScanState'|..., ...)`. Backend scans the CLI's own local session-transcript files and caches the parsed/aggregated result via `JsonFileUsageStatePersistence` (desktop, a local JSON file in Electron `userData`) or a swappable Postgres-backed `UsageStatePersistence` (server mode).
- **Mechanism (rate limits)**: `store/slices/rate-limits.ts` → `runtime/runtime-rate-limits-client.ts` → `callRuntimeRpc({kind:'local'}, 'rateLimits.get'|'refresh'|'refreshCodexForTarget'|..., ...)` → `backend/src/main/rate-limits/service.ts`'s `RateLimitService`, which has no persistence code at all. Push updates arrive via `window.api.rateLimits.onUpdate()`.
- **Nuance**: usage data's true source of record is always the external CLI's own transcript files on disk (Orca never owns the raw data, only a derived/cached index of it); rate limits are always a live snapshot from the provider APIs, re-fetched every poll/session with zero durable cache.

## 14. Workflow / task / trace slices

- **Persisted?** Workflow: Yes (Postgres relational). Task: Yes (Postgres relational), with two relay exceptions. Trace: No (ephemeral, in-process debug buffer).
- **Mechanism**: `store/slices/workflow.ts` and `task.ts` are pure state containers; the RPC calls live in `hooks/useWorkflow.ts`/`useWorkflowExecution.ts` (`callRuntimeRpc(target, 'workflow.template.create'|'workflow.execute'|'workflow.cancel', ...)`) and `hooks/useTask.ts`/`useTasks.ts` (`task.*` RPC). Backend: `orca_workflow_templates`/`orca_workflow_executions`/`orca_workflow_step_executions` and `orca_tasks`/`orca_task_edges`/`orca_task_comments`/`orca_task_grants` — genuine relational tables.
- `store/slices/trace.ts`: "Zustand slice that stores live trace events... Rolling buffer: keeps last 500 entries (FIFO)." No RPC/window.api call anywhere — it only receives events pushed from `shared/trace/index.ts`'s browser sink for the in-app `TracePanel` debug view.
- **Nuance**: `task.aiDecompose` and `task.execute` (complex-task path) both relay to the Dev Server Agent mid-flow even though the RPC call itself looks like a DB operation; `workflow.execute` returns immediately (DB-only) while async step execution (agent/shell/notification steps) relays.

## 15. Browser automation (embedded browser tabs' localStorage/cookies)

- **Persisted?** Yes, but not in Orca's Postgres blob or any Orca-owned store — it's Chromium's own on-disk state for that automated page.
- **Mechanism**: `backend/src/main/runtime/orca-runtime-browser.ts`'s `browserStorageLocalGet/Set/Clear` delegate to `requireAgentBrowserBridge().storageLocalGet/Set/Clear(key, worktreeId, browserPageId)` — this executes `localStorage.getItem/setItem/clear` inside the automated page's own JS context via CDP/`webContents`, i.e. it's the storage of whatever third-party website the agent is automating, not Orca's app state. Cookie import (`backend/src/main/browser/browser-cookie-import.ts`) reads/writes Chromium's SQLite cookie DB at `app.getPath('userData')/Partitions/<partitionName>/Cookies` under an Electron `persist:<partition>` session partition — durable, but at the Electron/Chromium userData level, entirely separate from `persistence.ts`'s blob.
- **Data shape**: arbitrary key/value strings (localStorage) and standard browser cookies, scoped per browser-session-profile partition; profile CRUD (`sessionListProfiles`/`sessionCreateProfile`/`sessionImportCookies`) manages which partition a given worktree's browser tab uses.
- **Important distinction**: this is automation-target storage (the pages the agent drives), never to be conflated with Orca's own settings/UI state or with the renderer's `localStorage`/`sessionStorage` covered in [`browser-storage.md`](./browser-storage.md) — it's a different browser context entirely (an embedded automated webview, not the Orca app's own window).

## 16. Devices/provisioning, bootstrap slice

- **Persisted?** No — both are ephemeral, in-memory progress-tracking UI state.
- **Mechanism**: `store/slices/bootstrap.ts` (`bootstrapByServer: Record<serverId, ServerBootstrapState>`) and `provisioning.ts`/`provisioning-events.ts` (`provisioningSession: ProvisioningSession | null`) have zero `window.api`/`callRuntimeRpc`/persistence references — both are pure step/phase/log-line progress displays for `ssh.bootstrapServer`'s live output, rebuilt fresh each run.
- **Data shape**: `{ serverId, phase, steps: BootstrapStep[], logLines, startedAt, completedAt }` / `{ sessionId, phase, servers: ProvisioningServerEntry[], concurrency }`.
- **Nuance**: no dedicated "devices" slice exists in `store/slices/`; the closest concepts are (a) SSH targets/dev servers themselves (see §5, durably persisted) and (b) mobile device pairing, tracked backend-side (`device-registry.ts`) but with no renderer Zustand slice of its own.

## 17. Memory slice

- **Persisted?** No (ephemeral — recomputed live on every fetch).
- **Clarification**: this is **not** an AI-agent conversational-memory feature. `store/slices/memory.ts`'s `MemorySnapshot` is CPU/RAM resource-usage telemetry for the Resource Manager status-bar segment — `{ app: AppMemory, worktrees: WorktreeMemory[], host: HostMemory, totalCpu, totalMemory, collectedAt }`.
- **Mechanism**: `fetchMemorySnapshot()` → `runtime/runtime-memory-client.ts` → `callRuntimeRpc({kind:'local'}, 'memory.getSnapshot')` → `backend/src/main/runtime/orca-runtime.ts`'s `getMemorySnapshot()` → `collectMemorySnapshot(this.store)`, which live-samples process/host CPU and memory each call. Nothing is written back to `persistence.ts`.
- **Nuance**: gated on `window.api.agentTrust` (desktop-only); the web build uses a stub `createEmptyMemorySnapshot()`. Not to be confused with `diagnostics.memory` (a different RPC method, backend's own process counters).

---

## Ephemeral / not persisted at all — roundup

Confirmed with no persistence path whatsoever (pure in-memory, lost on
restart, rebuilt from re-fetch or push events, or simply never durable):

- `worktree-nav-history.ts` — back/forward stack, max 50 entries
- `trace.ts` — live trace-event rolling buffer (500-entry FIFO) for the debug `TracePanel`
- `remote-agent-sessions.ts` — remote agent session map, rebuilt only from live `agentOrchestration` push events, no hydration call found
- `rate-limits.ts` — live provider rate-limit polling (Codex/Claude/MiniMax/Grok), `RateLimitService` has no persistence code
- `bootstrap.ts` — per-server bootstrap step/log progress display
- `provisioning.ts` / `provisioning-events.ts` — bulk SSH fleet relay deployment progress display
- `memory.ts` — live CPU/RAM resource snapshot (not AI-agent memory; recomputed every call)
- SSH/runtime-environment **connection status** specifically (`ssh.ts` / `runtime-environment-ssh.ts` connection-state maps) — explicitly documented as "runtime-only," even though the underlying SSH *targets* are persisted
- Jira/Linear **issue/project data itself** (only credentials persist; issue data is always a live re-fetch)
- GitHub **live data itself** beyond the `prCache`/`issueCache` blob cache (checks, comments, project rows are fetched fresh via `gh` CLI each time)
