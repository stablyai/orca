# Feature → Persistence Tier Matrix (Zustand store slices)

Every non-test `.ts` file in `frontend/src/renderer/src/store/slices/` (79
files), classified by what persistence call — if any — its actions make.
Method: grepped each file for `callRuntimeRpc(`, `window.api.*`, and
`runtime-*-client.ts` imports, then read the call sites to confirm the
trigger and destination.

**Reminder** (see [`README.md`](./README.md)): the root store uses **no**
Zustand `persist` middleware anywhere, so a slice with no persistence call
found below is genuinely lost on page refresh (web) or app restart
(desktop) — this is not partial data, it's the full story for that slice.

Two persistence idioms appear:
- **`window.api.<ns>.<method>`** — direct Electron preload IPC to the local
  main process (settings.json-equivalent, keybindings.json, OS-level APIs,
  pty control, local caches). Desktop-only; not backend/cross-device.
- **`callRuntimeRpc(target, method, …)` / `runtime-*-client.ts` wrappers** —
  routes to either `{kind:'local'}` (Electron main on this machine) or
  `{kind:'environment', environmentId}` (a remote SSH/dev-server running
  Orca's runtime). Used for git/file ops, worktree metadata, and
  cloud-integration state (Jira/Linear/orca-profiles/rate-limits/usage/
  memory/onboarding/sparse-presets/workspace-space). "Backend-persisted"
  here means "persisted by whichever host the active runtime target points
  at" — not necessarily a shared cloud database (see caveat below).
- `auth.ts` is the one outlier: a plain `fetch('/auth/me', {credentials:
  'include'})` REST call — genuine backend session-cookie auth.

`bootstrap.ts` is **not** app-wide startup hydration — it's per-dev-server
bootstrap-step automation (CR-004) and holds no persistence itself.
App-wide startup loading happens in `App.tsx`/`startup/startup-diagnostics.ts`,
outside `slices/`.

## Backend RPC-persisted

| Slice file | Feature | Evidence | file:line |
|---|---|---|---|
| `auth.ts` | User identity/session | `fetchCurrentUser()` → `fetch('/auth/me', {credentials:'include'})` | `auth/auth-api-client.ts:15-16`; called from `auth.ts:60,63` |
| `orca-profiles.ts` | Orca cloud profile connect/list | `fetchRuntimeOrcaProfiles`, `fetchRuntimeOrcaProfileAuthStatus`, `createRuntimeLocalOrcaProfile` | `orca-profiles.ts:17-19,58-59,76,87` |
| `orca-profiles-auth-actions.ts` | Cloud-linked profile auth | `createRuntimeCloudLinkedOrcaProfile(get().settings, args)` on explicit action | `orca-profiles-auth-actions.ts:13,42` |
| `jira.ts` | Jira integration connect/issues | `jiraConnect/jiraDisconnect/jiraSelectSite/jiraStatus/...` (39 `callRuntimeRpc` sites in the client) | `jira.ts:15-24` |
| `linear.ts` | Linear integration connect/issues | `linearConnect/linearSelectWorkspace/linearListIssues/...` (50 `callRuntimeRpc` sites) | `linear.ts:24-43` |
| `memory.ts` | Agent long-term "memory" snapshot | `getRuntimeMemorySnapshot()` | `memory.ts:4,25` |
| `onboarding-checklist.ts` | Onboarding checklist item completion | `markRuntimeOnboardingChecklistItem(...)` per item click | `onboarding-checklist.ts:8,79,98` |
| `rate-limits.ts` | Claude/Codex/Grok rate-limit tracking | `getRateLimitState`, `refreshClaudeRateLimitsForTarget`, `refreshCodexRateLimitsForTarget`, `refreshGrokRateLimits` on explicit refresh | `rate-limits.ts:4-13` |
| `claude-usage.ts` | Claude usage scan/snapshot | `getClaudeUsageSnapshot`, `refreshClaudeUsage`, `setClaudeUsageEnabled` | `claude-usage.ts:13-18` |
| `codex-usage.ts` | Codex usage scan/snapshot | Same pattern | `codex-usage.ts:13-18` |
| `opencode-usage.ts` | OpenCode usage scan/snapshot | Same pattern | `opencode-usage.ts:13-18` |
| `sparse-presets.ts` | Sparse-checkout presets | `listSparsePresets`, `saveSparsePreset`, `removeSparsePreset` on explicit save/delete | `sparse-presets.ts:6-10` |
| `workspace-space.ts` | Workspace disk-usage analysis | `analyzeWorkspaceSpace`, `cancelWorkspaceSpaceScan` on explicit scan | `workspace-space.ts:6-9` |
| `worktrees.ts` | Worktree CRUD, lineage, PR/MR base resolution | local: `window.api.worktrees.create`; remote fallback: `callRuntimeRpc`; `updateMeta`/`updateLineage`/`remove`/`forgetLocal` fire per action, not batched | `worktrees.ts:1107,1310-1313,3107-3108,3375-3377,3807` |
| `repos.ts` | Repo list (multi-host) | `window.api.repos.list()`, host-scoped; per-repo `executionHostId` via `getRuntimeTargetHostId` | `repos.ts:1336`, host logic `repos.ts:243-282` |
| `diffComments.ts` | PR/diff review comments | Stored **inside worktree metadata**: local `window.api.worktrees.updateMeta`, remote `callRuntimeRpc('worktree.set', ...)`, via internal `persist()` on every add/edit/delete | `diffComments.ts:98-117` |
| `editor.ts` | File open/edit/save, git push/pull/rebase from editor | Real disk/git I/O on active host via `runtime-git-client`/`runtime-file-client`: `fetchRuntimeGit`, `pushRuntimeGit`, `pullRuntimeGit`, `rebaseRuntimeGitFromBase`, `deleteRuntimePath` | `editor.ts:50-62,4239` |
| `hosted-review.ts` | Hosted PR/MR review creation | `window.api.hostedReview.*`: `getCreationEligibility`, `create`, `forBranch` on explicit action | `hosted-review.ts:262,288,368` |
| `github.ts` | GitHub issues/PRs/projects | **Mixed**: live data via `window.api.gh.*` (proxies GitHub's own API — GitHub is source of truth) + local cache `window.api.cache.setGitHub/getGitHub` | `github.ts:390,412,1746,2123-2525,2909` |

## Local desktop-only (Electron IPC, not backend/cross-device)

| Slice file | Feature | Evidence | file:line |
|---|---|---|---|
| `settings.ts` | Global app settings (`GlobalSettings`) | `window.api.settings.get()` on load, `.set(...)` on every mutation | `settings.ts:71,138,154` |
| `keybindings.ts` | Keyboard shortcut bindings | `window.api.keybindings.ensureFile/get/setAction/reload/openFile/revealFile` — every rebind writes immediately | `keybindings.ts:45-125` |
| `ui.ts` | Misc UI prefs (collapsed groups, worktree-card mode/props) | `uiSet({...})` and `window.api.settings.set(updates.settings)` per toggle | `ui.ts:2101,2115` |
| `runtime-status.ts` | Saved remote-Orca-server list + live reachability | `window.api.runtimeEnvironments.list()` (saved config, persisted); `.getStatus()` (live probe, not persisted) | `runtime-status.ts:113,134` |
| `stats.ts` | Usage stats summary | `window.api.stats.getSummary()` (read query, not a save) | `stats.ts:15` |
| `dictation.ts` | Speech/dictation model states | `window.api.speech.getModelStates()` (read query of installed OS models) | `dictation.ts:30` |
| `preflight.ts` | Local + remote integration preflight checks | `window.api.preflight.check(...)` local; `callRuntimeRpc` for remote — live check, not persisted | `preflight.ts:5,124` |
| `workspace-cleanup.ts` | Orphaned PTY/process cleanup | `window.api.pty.hasChildProcesses`/`.getForegroundProcess` — read + cleanup action, not a durable save | `workspace-cleanup.ts:920-921` |
| `terminals.ts` | Terminal/PTY lifecycle | `window.api.pty.kill(...)` process control (not data persistence); `callRuntimeRpc` for remote-host kill | `terminals.ts:2252,2685,2696` |
| `browser.ts` | In-app browser sessions/profiles/cookies | `window.api.browser.sessionListProfiles/sessionCreateProfile/sessionDeleteProfile/sessionImportCookies/sessionDetectBrowsers/sessionImportFromBrowser/sessionClearDefaultCookies`; one `callRuntimeRpc` for remote-host browser routing | `browser.ts:298,1745,1773,1820,1866,1933,2008,2069` |

## Slices with no persistence found (in-memory only)

Confirmed by absence of any `window.api`/`callRuntimeRpc`/`runtime-*-client`
call anywhere in the file. **Lost on page refresh (web) / app restart
(desktop) today.**

| Slice file | Feature | Note |
|---|---|---|
| `tabs.ts` | Tab/pane/split layout (2070 lines) | No persistence call anywhere |
| `tabs-hydration.ts` | Tab-state hydration helpers | Rebuilds in-memory shape, not a disk/backend read |
| `tab-group-state.ts` | Tab group creation helpers | Pure helper, no persistence |
| `workflow.ts` | Workflow templates/executions | Own comment acknowledges fetch-wiring isn't live yet (`workflow.ts:21,37`) |
| `task.ts` | Task list | No persistence call |
| `git-panel.ts` | Git status/history/branches/diff panel | Own comment: fetches "haven't succeeded on this deployment" yet (`git-panel.ts:62-63`) |
| `dev-servers.ts` | Dev server list/status | Pure reducer, populated externally |
| `ssh.ts` | SSH fleet import/health/credential-request state | No persistence call in 365-line file |
| `ai-provider-slice.ts` | AI provider accounts + today's usage | No `window.api`/`callRuntimeRpc` anywhere; pure reducer |
| `profile-slice.ts` | Org/dept/user profile hierarchy | Pure reducer — populated by a caller not yet wired, or awaiting backend integration |
| `new-issue-draft.ts` | Draft GitHub issue being composed | Lost on refresh |
| `pull-request-generation.ts` | AI-generated PR title/body draft | No persistence call |
| `commit-message-generation.ts` | AI-generated commit message draft | No persistence call |
| `provisioning.ts` | Bulk SSH fleet relay provisioning progress | No persistence call |
| `runtime-environment-ssh.ts` | SSH runtime-environment connection state | No persistence call |
| `remote-agent-sessions.ts` | Remote agent sessions (agentOrchestration IPC) | Tracked live via IPC events, not saved |
| `worktree-nav-history.ts` | Worktree navigation back/forward history | No persistence call |
| `settings-search-state.ts` | Settings-panel search/debounce state | Ephemeral by design |
| `github-checks.ts` | GitHub PR check-run cache | Pure in-memory session cache (keyed by `github-cache-key.ts`) |
| `agent-status.ts` | Live agent working/idle detection from PTY output | Correctly ephemeral — live-process state |
| `agent-status-freshness-scheduler.ts` | Timer helper for agent-status freshness | Helper, no persistence |
| `ssh-target-cleanup.ts` | SSH connection/target cleanup logic | No persistence call |
| `trace.ts` | Live trace-event stream (debug) | Explicitly a live event sink per header comment (`trace.ts:1-3`) |
| `bootstrap.ts` | Per-dev-server bootstrap step automation (CR-004) | Not app-startup hydration; itself unpersisted |

## Pure helpers / type-only / test fixtures (not a persistence question)

`dev-servers-selectors.ts`, `pane-column-split-drop-no-op.ts`,
`pane-foreground-agent.ts`, `pinned-tab-close-confirm.ts`,
`provisioning-events.ts`, `onboarding-checklist-selectors.ts`,
`github-cache-key.ts`, `github-project-row-owner.ts`,
`github-work-items-query-bounds.ts`, `hosted-review-cache-identity.ts`,
`project-group-removal-targets.ts`, `repo-host-identity.ts`,
`repo-identity-reconcile.ts`, `repo-reorder-host-split.ts`,
`readopted-ssh-worktree-rows.ts`, `superseded-ssh-repo-rows.ts`,
`browser-webview-cleanup.ts`, `terminal-helpers.ts`,
`terminal-orphan-helpers.ts`, `worktree-helpers.ts`, `bootstrap-events.ts`,
`store-test-helpers.ts`, `workspace-cleanup-slice-test-harness.ts`,
`repos-all-hosts-fixture.ts`, `repos-runtime-routing-fixture.ts`.

## Notes on specifically important slices

- **`worktrees`, `repos`, `editor`, `diffComments`** — the most "durable"
  tier: real git/file operations and worktree metadata persisted to disk on
  whichever host (local machine or remote dev-server) owns that worktree.
  Not a central Postgres DB — durability means "real files/git state exist
  on a host," consistent with `git-gateway-service` having been given real
  git tooling + storage.
- **`settings`, `keybindings`, `ui`, `runtime-status` (saved server list),
  `stats`, `dictation`** — Electron-local disk (settings.json/
  keybindings.json equivalents), non-cross-device. Note: on the **web
  build**, `settings` and `ui` fall back to the localStorage hybrid in
  [`ui-settings-session-hybrid.md`](./ui-settings-session-hybrid.md) instead
  of true Electron IPC — see that doc for the field-coverage gap.
- **`auth`** — the one slice backed by an actual REST session-cookie
  endpoint, distinct in mechanism from everything else.
- **`jira`, `linear`, `orca-profiles`, `memory`, `onboarding-checklist`,
  `rate-limits`, `sparse-presets`, `workspace-space`,
  `claude/codex/opencode-usage`** — all route through `runtime-*-client.ts`
  → `callRuntimeRpc`, the **same generic transport** used for git/file ops
  (local Electron main or a remote runtime environment) — not a separate
  cross-device cloud backend. "Durable across devices" only holds if the
  active runtime environment is a shared remote host.
- **`dev-servers`, `ssh`, `workflow`, `task`, `git-panel`, `tabs`,
  `ai-provider-slice`, `profile-slice`** — confirmed **in-memory only**,
  a real finding: this data is lost on refresh/restart today. `workflow.ts`
  and `git-panel.ts` even have code comments acknowledging the wiring isn't
  live yet.
- **`agent-status`, `browser`** — mixed: `agent-status` is purely ephemeral
  live-process detection (correctly unpersisted); `browser` persists
  session/cookie/profile management through Electron's session APIs, but
  page/tab state itself lives in `tabs.ts` (in-memory).
