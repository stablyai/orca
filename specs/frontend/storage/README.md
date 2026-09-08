# Frontend Storage Audit

Where does Orca's frontend (renderer) state actually live? This directory
answers that for the whole `frontend/` tree, across five documents:

- [`browser-storage-catalog.md`](./browser-storage-catalog.md) — every
  direct `localStorage`/`sessionStorage` call site in the renderer (file:line
  cited), grouped by feature: onboarding/dismissal flags, layout/panel
  geometry, GitHub-project-board UI state, auth/session/dev-server-connection
  keys, and diagnostics/dev-tooling.
- [`ui-settings-session-hybrid.md`](./ui-settings-session-hybrid.md) — a deep
  dive on the three `window.api` namespaces that carry the *bulk* of Orca's
  state (`ui`, `settings`, `session`/workspace-session), and exactly how each
  falls back to a localStorage-backed cache on the web build vs. real disk
  storage on desktop — including the biggest gap this audit found (see
  below).
- [`feature-persistence-matrix.md`](./feature-persistence-matrix.md) — every
  Zustand store slice (`store/slices/*.ts`), classified by which persistence
  call (if any) its actions make: backend-RPC-persisted, local-desktop-only
  (Electron IPC), or genuinely in-memory-only (lost on refresh/restart today).
- [`backend-persistence.md`](./backend-persistence.md) — the same question
  from the opposite direction: for each *feature area* (worktrees, terminals/
  tabs, GitHub/Jira/Linear integrations, auth, SSH/dev-servers, AI provider
  profiles, workflows/tasks, usage/rate-limits, browser automation, etc.),
  what's persisted, where, and by which RPC/IPC method — cross-referenced
  against the existing `specs/frontend/api/*.md` RPC/IPC/HTTP catalogs.
- [`dev-server-agent-impact.md`](./dev-server-agent-impact.md) — a
  cross-cutting risk pass over the four docs above, answering "which stored
  state, if lost or stale, actually breaks a remote dev-server agent" (as
  opposed to just being a cosmetic UI-preference loss).

## Headline findings

1. **No IndexedDB, no Zustand `persist` middleware, anywhere in the
   renderer.** Every client-side persistence path is a hand-rolled
   `localStorage.getItem`/`setItem` call; every durable, cross-restart Zustand
   slice instead goes through `window.api` (Electron IPC) or `callRuntimeRpc`
   (remote runtime RPC) to a real backend, or isn't persisted at all.
2. **Desktop build**: `localStorage`/`sessionStorage` are used only for
   ~30 small, deliberately non-synced concerns — cosmetic per-device UI
   prefs (panel position, column widths), one-time onboarding/dismissal
   flags, Feature Wall step tracking, two bug-investigation diagnostic ring
   buffers (one for an already-resolved bug, both cleanup candidates), and
   resilience guards (lazy-chunk-reload, dev-only preview flags). None of
   this is business data, and none of it is authentication material.
3. **Web build** (no Electron main process): `localStorage` is instead the
   **entire persistence tier** for the `ui`, `settings`, `session`
   (workspace-session), `onboarding`, GitHub-cache, and `keybindings`
   domains — `web-preload-api.ts` reimplements the whole `window.api`
   surface as localStorage-backed shims.
4. **The single biggest gap this audit found**: on the web build, the
   `settings` RPC sync only round-trips **~5 of ~200** `GlobalSettings`
   fields to the backend (`experimentalNewWorktreeCardStyle`,
   `compactWorktreeCards`, `minimaxGroupId`, `minimaxUsageModels`,
   `prBotAuthorOverrides`). Everything else — terminal theme/appearance,
   proxy config, notification prefs, default-agent settings — **never
   leaves the browser** for a web client; `orca.web.settings.v1` is its
   sole copy. `ui` state, by contrast, syncs in full (no allowlist). Full
   detail in [`ui-settings-session-hybrid.md`](./ui-settings-session-hybrid.md).
5. **Auth/session tokens are never put in Web Storage.** Session auth is an
   HttpOnly cookie (`orca_session`); the one exception is the web build's
   E2EE pairing `deviceToken`, XOR-obfuscated with an in-memory-only key
   before landing in `localStorage` (fixing a prior plaintext bug,
   BUG-FE-HLD-001) — see `browser-storage-catalog.md` §4.
6. **Real app/business data** (worktree metadata, terminal tabs/session,
   settings/keybindings, auth, SSH/dev-server targets, onboarding checklist,
   AI-provider/profile config, Jira/Linear connect state, workflows, tasks)
   is backend-persisted through the Electron main process's `Store`
   (`backend/src/main/persistence.ts`) — see the important caveat at the top
   of [`backend-persistence.md`](./backend-persistence.md) on **what backs
   that `Store`**: a single local JSON file (`orca-data.json`) for a desktop
   single-user install, vs. Postgres in a multi-tenant/server deployment of
   the same backend abstraction.
7. **A real, separate finding — several slices have no persistence path at
   all today**, independent of the web/desktop split: `tabs.ts` (tab/pane
   layout, 2070 lines), `workflow.ts` and `git-panel.ts` (both have code
   comments acknowledging the wiring isn't live yet), `dev-servers.ts`,
   `ssh.ts`, `ai-provider-slice.ts`, `profile-slice.ts`,
   `remote-agent-sessions.ts`, `worktree-nav-history.ts`, `trace.ts`,
   `new-issue-draft.ts`, `pull-request-generation.ts`,
   `commit-message-generation.ts`, `bootstrap.ts`, `provisioning.ts`, and
   more — full list with rationale in `feature-persistence-matrix.md`.

## Quick-reference matrix

| Feature area | Browser storage (local/session) | Local backend (Electron `Store` — file or Postgres, see caveat) | Remote / 3rd-party | Ephemeral only |
|---|---|---|---|---|
| Worktree metadata (pin, sort, diff comments) | — | ✅ `Store` | — | Nav history only |
| Terminal tabs / tab groups / session | Web build: sole copy, no RPC at all | ✅ `Store` (desktop) | Tab props mirror to remote host if runtime-owned | PTY processes themselves |
| Settings (`GlobalSettings`) | Web build: sole copy for ~195/200 fields | ✅ `Store` (desktop, full object); only ~5 fields sync for web | — | — |
| UI state (`PersistedUIState`) | Web build: full optimistic cache | ✅ `Store`, no allowlist (full sync) | — | — |
| Keybindings | Web build: local-only shim, cross-tab synced | ✅ `~/.orca/keybindings.json` | — | — |
| Auth / session | Web build: XOR-wrapped pairing token only | — | ✅ HttpOnly cookie + `orca_users`/auth server | Zustand copy re-derived each launch |
| SSH targets / dev servers | Web build: default-picker convenience key (sole copy, no sync) | ✅ `Store` (saved list); desktop-only, not cross-device | — | Live connection status; `ssh.ts`/`provisioning.ts` entirely |
| GitHub PR/issue cache | Web build: local-only shim | ✅ `Store` (TTL cache) | ✅ GitHub via `gh` CLI (source of truth) | Checks/comments/project rows; `github-checks.ts` |
| Jira / Linear issues | — | Credentials only (encrypted file) | ✅ Jira REST / Linear GraphQL (source of truth) | Issue/project data itself |
| Hosted review | — | `pr_created` stats → local JSON file | ✅ GitHub/GitLab/Bitbucket/Azure DevOps/Gitea | Eligibility/creation checks |
| Onboarding checklist | Feature Wall step-tracking (separate, local-only concept) | ✅ `Store` | — | — |
| AI provider / Orca profiles | — | Status metadata only (relational tables in server mode) | Dev Server Agent for credential write/rotate (ciphertext only) | `ai-provider-slice.ts`/`profile-slice.ts` (pure reducers) |
| Remote agent sessions | — | — | — | ✅ fully ephemeral |
| Usage tracking (Claude/Codex/OpenCode) | — | ✅ local JSON file (desktop) / Postgres (server mode) | Reads external CLI transcript files | — |
| Rate limits | — | — | ✅ live poll of provider APIs | ✅ no cache at all |
| Workflows / Tasks | — | Relational tables in server mode | Relays to Dev Server Agent mid-flow for AI/agent steps | `workflow.ts`/`task.ts` slices themselves are unwired reducers |
| Trace / debug panel | `ORCA_TRACE` toggle flag | — | — | ✅ 500-entry in-memory FIFO |
| Browser-automation tab storage | — | — | — | Chromium's own storage for the *automated* page (not Orca state) |
| Cosmetic UI prefs (panel position, column widths, dismissal flags) | ✅ localStorage/sessionStorage | — | — | — |
| Diagnostic ring buffers (bug repros) | ✅ localStorage | — | — | — |

For exact keys, RPC method names, file:line references, and the nuances
behind every cell above, follow the links into the five detail documents.
