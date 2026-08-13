# Add Huly as an Orca TaskProvider

Mirror the Linear connector end‑to‑end, but back it with the
[`huly` CLI](https://github.com/IamCoder18/huly-cli) (same pattern Orca uses for
`gh` and `glab`). Multi‑connection per install (one base URL + workspace +
credentials per connection), tasks show in the existing Tasks page, projects
behave like Linear's project view, and the agent skill is the community
`IamCoder18/huly-cli` skill (`npx skills add IamCoder18/huly-cli`).

## Deployment modes — both local Orca and `orca serve` are in scope

Orca supports two deployment shapes, both must work for Huly in v1:

- **Local Orca** — renderer and main process on the same machine
  (default Electron app).
- **`orca serve`** — renderer is a web browser on the user's laptop;
  the Orca main process runs on a remote machine (an SSH host, a dev
  box, etc.). The renderer is connected to it via
  `settings.activeRuntimeEnvironmentId`
  (`src/renderer/src/lib/provider-runtime-context.ts:11`).

In both modes, **the Huly CLI and the Huly credentials live on whichever
machine the Orca main process is running on** (not on the laptop running
the browser). All `huly` invocations and all `safeStorage` reads happen
server‑side. The renderer's connect dialog POSTs the credentials over
runtime RPC, where they are stored on the server machine. The CLI
install prerequisite also lives on the server machine — if the user is on
`orca serve`, they need `npm i -g @iamcoder18/huly-cli` on the **server**,
not on their laptop.

This is exactly the model GitHub uses today: `gh` runs on whichever Orca
server the renderer is connected to, and the user only configures auth on
that server. No new architecture is needed — the runtime RPC layer added
in §3 routes every Huly call to the server.

## Design clarification: how Linear actually binds projects

Linear does **not** bind an Orca worktree to a Linear project.

- `LinearTaskProviderIdentity` (`src/shared/task-provider-identity.ts:17`)
  carries `workspaceId`, `workspaceName`, `teamId`, `teamKey` — no
  `projectId`.
- `Worktree.linkedWorkItem` (`src/shared/types.ts:362`) is a single issue
  (`type: 'issue'`, `linearIdentifier: 'ENG-123'`), not a project.
- Projects are a **runtime-only** filter inside `TaskPage.tsx`
  (`selectedLinearProjectId`, `linearProjectTab` — lines 4451, 5076–5141,
  8401, 12001). They live in component state and are not persisted per
  worktree.

So for Huly the binding is: worktree → `HulyTaskProviderIdentity` with
`connectionId + workspaceId + teamId/teamKey` (no `projectId`), and the
Tasks page exposes a runtime project picker (`selectedHulyProjectId` /
`hulyProjectTab`).

The plan is ordered for an implementing agent. Each step lists the file(s) to
add or extend and the Linear/GitHub file to copy from. After the core wiring
is in, settings → tasks flow must work before polish.

## Provider ordering — Huly-first when configured

Two lists drive provider order today, and they must stay in lockstep:

- `TASK_PROVIDERS` in `src/shared/task-providers.ts:3` (currently
  `['github', 'gitlab', 'linear', 'jira']`) — used for default
  `visibleTaskProviders`, normalize/filter fallbacks, and the order the
  Settings → Tasks pane renders integration cards.
- `getSourceOptions()` in
  `src/renderer/src/components/task-page-localized-options.tsx:113-134` —
  the Tasks page source picker order.

After adding Huly:

- **Default (unconfigured) order**: `['github', 'gitlab', 'linear', 'jira',
  'huly']` — Huly appended at the end so existing users see no reorder.
- **When Huly is connected**: Huly is promoted to position 0 in the source
  picker, and `defaultTaskSource` resolves to `'huly'` (Tasks opens to
  Huly). All other providers stay in their normal slots.

Concretely:

- Add `hulyConnected: boolean` to `TaskProviderAvailability`
  (`src/shared/task-providers.ts:55`).
- Add `orderTaskProviders(visibleProviders, availability)` in
  `src/shared/task-providers.ts` — default order matches `TASK_PROVIDERS`,
  but if `availability.hulyConnected` is true, Huly moves to position 0.
- In `TasksPane.tsx`, replace
  `visibleProviders.map(provider => PROVIDER_META[provider])` with
  `orderTaskProviders(visibleProviders, availability).map(...)` so the
  Settings card list obeys the Huly-first rule.
- In `resolveVisibleTaskProvider`, when `availability.hulyConnected` and
  `huly` is in `visibleProviders`, return `'huly'` ahead of the user's saved
  `defaultTaskSource`. Otherwise fall back to current behavior.
- In `task-page-localized-options.tsx`, add an overload
  `getSourceOptions({ availability })` that applies the same Huly-first
  rule. `TaskPage.tsx` calls the overload where availability is in scope
  (it already is via `useTaskSourceProviderReadiness`).
- `TaskProviderAvailability` flows into the renderer via
  `useTaskSourceProviderReadiness` (already wired for the existing
  providers) — extend it to surface `hulyConnected` so the new helper has
  what it needs.

---

## 1. Shared types and registry

Extend the existing Linear/Jira/GitHub scaffolding one entry at a time.

- **`src/shared/task-providers.ts`** — add `'huly'` to `TaskProvider`, push to
  `TASK_PROVIDERS`, add `hulyConnected: boolean` to `TaskProviderAvailability`
  (so the Huly promotion rule below can read connection status without each
  consumer re-deriving it). Update `filterAvailableTaskProviders`,
  `normalizeTaskProviderSettings`, `normalizeVisibleTaskProviders`,
  `resolveVisibleTaskProvider`, `restoreAvailableDefaultTaskProvider`,
  `isTaskProviderAvailable`. The array order becomes
  `['github', 'gitlab', 'linear', 'jira', 'huly']` (Huly appended at the end
  — see "Provider ordering" below for the runtime override).
- **`src/shared/task-providers.ts`** — add
  `orderTaskProviders(visibleProviders, availability)` helper that returns
  the visible providers in display order. Default order is the
  `TASK_PROVIDERS` array order. **If `availability.hulyConnected` is true,
  Huly is moved to position 0** ("Huly-first when configured" rule). All
  consumers must call this helper instead of iterating
  `visibleProviders` directly.
- **`src/shared/task-provider-identity.ts`** — add `HulyTaskProviderIdentity`
  to the discriminated union. Mirror `LinearTaskProviderIdentity` shape:
  `{ provider: 'huly', connectionId, workspaceId?, workspaceName?, teamId?,
  teamKey? }`. **No `projectId` field.** Linear does not bind a worktree to a
  project (`src/shared/task-provider-identity.ts:17`); projects are a
  runtime-only filter in `TaskPage.tsx` (`selectedLinearProjectId`,
  `linearProjectTab`). Huly follows the same rule. Extend every
  `switch (provider)` (`normalizeTaskProviderIdentity`,
  `isStoredTaskProviderIdentity`, `taskProviderIdentityCachePart`,
  `TASK_PROVIDER_IDENTITY_FIELDS`).
- **`src/shared/task-source-context.ts`** — `TaskSourceContext` and
  `buildTaskSourceContextFromRepo` / `normalizeTaskSourceContext` /
  `normalizeStoredTaskSourceContext` / `getTaskSourceCacheScope` need
  `provider: 'huly'` cases; `normalizeTaskProvider` switch at bottom.
- **`src/shared/task-source-context-schema.ts`** — verify the Zod schema still
  resolves the new branch via `normalizeStoredTaskSourceContext`.
- **`src/shared/types.ts`** — add `HulyViewer`, `HulyConnection`,
  `HulyConnectionStatus`, `HulyWorkspaceSelection` (string | `'all'`, same shape
  as `LinearWorkspaceSelection`), `HulyIssue`, `HulyProjectSummary`,
  `HulyProjectDetail`, `HulyComment`, `HulyIssueState`, `HulyTeamSummary`.
  Mirror the field set used by the existing `LinearIssue` / `LinearProject*`.
- **`src/shared/constants.ts`** — ensure `defaultSettings.visibleTaskProviders`
  inherits the new entry.
- **`src/shared/agent-feature-install-commands.ts`** — add
  `HULY_AGENT_SKILL_INSTALL_COMMAND = 'npx skills add IamCoder18/huly-cli'`
  and a `HULY_AGENT_SKILL_NAMES = ['huly-cli']` (matches Linear's
  `ORCA_LINEAR_SKILL_NAME` pattern, but using the community skill name).
- **`src/shared/protocol-version.ts`** — add
  `HULY_RUNTIME_CAPABILITY = 'huly.runtime.v1'` if any new payload field is
  added to RPC methods (likely `connectionId` everywhere — capability‑gate
  per `docs/reference/remote-wire-compatibility.md`).
- **`src/shared/integration-credential-errors.ts`** — add a `'huly'` service
  name with a friendly message (parallel to `'linear'`, `'jira'`).
- **`src/shared/new-workspace/workspace-source.ts`** — add
  `buildHulyWorkspaceSource` (mirror `buildLinearWorkspaceSource`).
- **`tests/shared/task-providers.test.ts`** + a new
  `task-provider-identity.test.ts` + `task-source-context.test.ts` — cover
  the new branch in every normalize / filter function.

---

## 2. Main process: Huly client (CLI wrapper)

Back everything with the `huly` binary, but keep Orca in charge of the
credentials (stored via `safeStorage` like Linear) so the user does not need to
run `huly login` themselves.

- **`src/main/huly/huly-cli.ts`** — thin wrapper around `spawn('huly', args, {
  env: { ...process.env, HULY_URL, HULY_EMAIL, HULY_PASSWORD | HULY_TOKEN,
  HULY_WORKSPACE, HULY_NONINTERACTIVE: '1' } })`. Always pass `--json` and
  `--ci`. Parse stdout JSON. Surface stderr as an error class. Add a
  `preflightHulyCli()` that runs `huly --version` and `huly whoami --json`
  (catches missing binary / unauthenticated). Mirror
  `src/main/github/gh-utils.ts` for timeouts, retries, and exit‑code
  classification. All spawns happen **on the Orca server process** — when
  the renderer is connected via `orca serve`, the spawn happens on the
  remote host, not on the user's laptop, and credentials are read from
  that host's `safeStorage`.
- **`src/main/huly/client.ts`** — `HulyClient` class modeled on
  `src/main/github/client.ts` (CLI wrapper) and `src/main/linear/client.ts`
  (per‑connection safeStorage). Public surface:
  - `saveConnection({ name, url, workspace, email, token }) → HulyConnection`
  - `loadConnection(id)`, `listConnections()`, `disconnect(id)`,
    `selectWorkspace(id | 'all')` (Linear‑style)
  - `getStatus()` — returns
    `{ connected, cliInstalled, cliAuthenticated, connections,
    activeConnectionId, selectedConnectionId, credentialError? }` without
    decrypting (Linear contract).
  - `getClient(connectionId)` / `getClients(connectionId | 'all')` — fan‑out
    to one `HulyCliHandle` per connection.
  - `testConnection(connectionId)` — clears cached state on auth failure
    (Linear pattern).
  - Concurrency limiter (`acquire` / `release`, cap ≈ 4 in flight), one
    limiter shared across connections.
  - Token files at `~/.orca/huly-connections/<base64url(connectionId)>.enc`;
    metadata at `~/.orca/huly-connections.json`.
- **`src/main/huly/issues.ts`** — `listIssues`, `getIssue`, `createIssue`,
  `updateIssue`, `addComment`, `listComments` (each maps `HulyCliHandle` →
  `HulyIssue` / `HulyComment`). The CLI equivalents are `huly issue list
  --project <ref>`, `huly issue get <ref>`, `huly issue create …`, `huly
  issue update …`, `huly thread …`. Use `huly ws <method>` only when no CLI
  verb covers the call (per huly‑cli skill rule 7).
- **`src/main/huly/projects.ts`** — `listProjects`, `getProject`,
  `createProject`, `listProjectIssues`. Map → `HulyProjectSummary` /
  `HulyProjectDetail`.
- **`src/main/huly/teams.ts`** — `listTeams`, `teamMembers`, `teamStates`,
  `teamLabels` (parity with Linear's team‑level lookups for filter UIs).
- **`src/main/huly/mappers.ts`** — pure functions from CLI JSON → shared
  `Huly*` types. No I/O. Mirror `src/main/linear/mappers.ts`.
- **`src/main/huly/huly-cli-preflight.ts`** — exported `getHulyPreflight()`
  returning `{ installed, version, authenticated, accountEmail }`; used by
  the renderer status hooks and the setup wizard. Mirror
  `src/main/github/preflight.ts` if present, else `gh-utils.ts`.
- Colocated `*.test.ts` for each of the above (Linear/Jira put them
  alongside — match that).

---

## 3. IPC + Runtime RPC + Orca runtime service

Two parallel registries must be updated (local IPC and runtime RPC). Mirror the
Linear split.

- **`src/main/ipc/huly.ts`** — `registerHulyHandlers()` exporting every
  channel (`huly:connect`, `huly:disconnect`, `huly:status`,
  `huly:selectWorkspace`, `huly:testConnection`, `huly:listConnections`,
  `huly:listIssues`, `huly:getIssue`, `huly:createIssue`,
  `huly:updateIssue`, `huly:addComment`, `huly:listComments`,
  `huly:listProjects`, `huly:getProject`, `huly:createProject`,
  `huly:listProjectIssues`, `huly:listTeams`, `huly:teamMembers`,
  `huly:teamStates`, `huly:teamLabels`). zod‑validate payloads, wrap the
  `HulyClient` calls, surface `credentialError`.
- **`src/main/ipc/register-core-handlers.ts`** — call `registerHulyHandlers()`
  alongside the existing `registerLinearHandlers` / `registerJiraHandlers`.
- **`src/main/ipc/huly.test.ts`** — register/unregister smoke + auth error
  path, mirroring `src/main/ipc/linear.test.ts`.
- **`src/main/runtime/rpc/methods/huly.ts`** — `RpcMethod[]` registry that
  calls into `OrcaRuntimeService` (zod‑validated payloads). One entry per
  IPC channel. Mirror `src/main/runtime/rpc/methods/linear.ts`.
- **`src/main/runtime/orca-runtime.ts`** — add `hulyConnect`, `hulyStatus`,
  `hulyListIssues`, `hulyGetIssue`, `hulyCreateIssue`, `hulyUpdateIssue`,
  `hulyAddComment`, `hulyListComments`, `hulyListProjects`, `hulyGetProject`,
  `hulyCreateProject`, `hulyListProjectIssues`, `hulyListTeams`,
  `hulyTeamMembers`, `hulyTeamStates`, `hulyTeamLabels` (search for
  `linearConnect` for the exact insertion shape; method registrations are
  alphabetical by provider in `register-core-handlers.ts`). These methods
  run on the Orca server that the renderer is connected to — local Orca by
  default, or the remote Orca server when the user is on `orca serve`
  (`settings.activeRuntimeEnvironmentId` is set). This is the path that
  makes `orca serve` + Huly work end-to-end.
- **`src/main/runtime/rpc/methods/huly.test.ts`** — exercise the RPC
  validators and a stubbed `OrcaRuntimeService`.

---

## 4. Preload bridge

- **`src/preload/index.ts`** (around the `window.api.linear` block at
  ~line 1724) — add `window.api.huly.{connect, disconnect, selectWorkspace,
  status, testConnection, listConnections, listIssues, getIssue, createIssue,
  updateIssue, addComment, listComments, listProjects, getProject,
  createProject, listProjectIssues, listTeams, teamMembers, teamStates,
  teamLabels}`. Types from `api-types.ts`.
- **`src/preload/api-types.ts`** (around the linear types at ~line 2130) —
  declare the same surface.

---

## 5. Renderer runtime client

- **`src/renderer/src/runtime/runtime-huly-client.ts`** — mirror
  `runtime-linear-client.ts`: for each op, branch on
  `getActiveRuntimeTarget(settings)` to call `window.api.huly.*` or
  `callRuntimeRpc<...>(target, 'huly.<method>', payload)`. Capability‑gate any
  newer payload field with the flag added in §1.
- **`src/renderer/src/runtime/runtime-huly-client.test.ts`** — covers the
  local/RPC branch and capability gating. Mirror
  `runtime-jira-client.test.ts`.

---

## 6. Renderer store slice

- **`src/renderer/src/store/slices/huly.ts`** — SWR caches modeled on the
  Linear slice: `hulyStatus`, `hulyIssueCache`, `hulyListCache`,
  `hulyTeamCache`, `hulyProjectCache`, `hulyProjectDetailCache`,
  `hulyProjectIssueCache`. Mutators: `connectHuly`, `selectHulyWorkspace`,
  `disconnectHuly`, `disconnectHulyConnection`, `fetchHulyIssue`,
  `searchHulyIssues`, `listHulyIssues`, `listHulyProjects`, `listHulyTeams`,
  etc. Invalidate the matching cache on every mutation.
  `CACHE_TTL = 60_000` (10 × that for teams). Copy the structure of
  `src/renderer/src/store/slices/linear.ts` (~2240 lines), keep the slice
  smaller initially — only the caches needed for the Tasks page.
- **`src/renderer/src/store/index.ts`** — register the slice.
- **`src/renderer/src/store/slices/huly.test.ts`** — Zustand tests with
  `vi.mock('@/runtime/runtime-huly-client')`; mirror
  `src/renderer/src/store/slices/linear.test.ts` for the key cases
  (connect/disconnect cascade, cache invalidation).
- **`src/renderer/src/hooks/useHulyProviderConnected.ts`** — boolean selector
  parallel to `useLinearProviderConnected`.

---

## 7. Settings UI

- **`src/renderer/src/components/icons/HulyIcon.tsx`** — SVG icon (mirror
  `LinearIcon`/`JiraIcon`).
- **`src/renderer/src/components/huly-connection-dialog.tsx`** — collects
  `name`, `base URL` (required), `workspace` (required), `email`,
  `password` (mutually exclusive with `token`). Validates by calling
  `hulyConnect` + a transient `huly whoami` before saving. Mirror
  `linear-api-key-dialog.tsx` (Linear) but with the extra fields and the
  "self‑hosted" framing.
- **`src/renderer/src/components/settings/task-provider-integration-section-ids.ts`**
  — add `HULY_INTEGRATION_SECTION_ID = 'integrations-huly'`.
- **`src/renderer/src/components/settings/task-tracker-integration-cards.tsx`**
  — add `HulyIntegrationCard` (parallel to `LinearIntegrationCard`). Shows
  CLI preflight status, list of saved connections, connect/edit/disconnect
  buttons, copy that adapts to `hasRemoteProviderRuntime(settings)` (Linear
  pattern). When the renderer is on `orca serve`, the card must (a) say so
  ("Huly CLI must be installed on the Orca server, not your laptop"), and
  (b) render the preflight status that the server reports (no client-side
  CLI check).
- **`src/renderer/src/components/settings/TaskSourceHulySetup.tsx`** — three
  steps (Connect → Install agent skill → Show in Tasks). Mirror
  `TaskSourceLinearSetup.tsx` 1:1; the skill step uses
  `HULY_AGENT_SKILL_INSTALL_COMMAND` and links to the GitHub repo
  (`https://github.com/IamCoder18/huly-cli`). Tests in
  `TaskSourceHulySetup.test.tsx`.
- **`src/renderer/src/components/settings/TasksPane.tsx`** — extend
  `PROVIDER_META` and the per‑provider setup card map with a `'huly'` entry.
- **`src/renderer/src/components/settings/use-task-source-provider-readiness.ts`**
  — add `hulyConnected`, `hulyChecking`, `hulySkillRequired` branches (Linear
  has the skill‑required variant; mirror it).
- **`src/renderer/src/components/settings/task-source-setup-state.ts`** — add
  Huly to the `ORDER`/`TaskProviderReadiness` map.
- **`src/renderer/src/components/settings/HulyAgentSkillPane.tsx`** +
  `huly-agent-skill-install-cta.tsx` + `HulyAgentSkillNotes.tsx` — mirror
  the Linear agent skill pane trio, but the CTA copy is "Install Huly CLI
  skill" and the command is the one from `agent-feature-install-commands.ts`.
- **`src/renderer/src/components/settings/Settings.tsx`** — gate Huly
  sections behind `useHulyProviderConnected()` (same place Linear's
  sections are gated, line ~342).
- **`src/renderer/src/components/sidebar/HulyAgentSkillSetupPrompt.tsx`** —
  mirror `LinearAgentSkillSetupPrompt.tsx`.

---

## 8. Tasks page, drawer, and project view

This is the user‑visible win — Huly issues/projects must show in the existing
Tasks page.

- **`src/renderer/src/components/TaskPage.tsx`** — add
  `taskSource === 'huly'` branches wherever `'linear'` is handled: header
  provider label, source picker, list renderer, filter dropdowns,
  scope selector, create‑issue dialog, project tab. Copy the linear branch
  and rename. Also update the provider normalization (~line 3155) and the
  per‑provider `TaskSourceContext` builder (~3360–3500) and the per‑provider
  render branches (~8965, ~9412, ~10989).
- **`src/renderer/src/components/task-source-provider-availability.ts`** —
  mark `'huly'` as account‑backed (not repo‑backed), like Linear/Jira.
- **`src/renderer/src/components/task-page-huly-*.tsx`** — page‑specific
  state files mirroring the existing `task-page-linear-*.tsx` set
  (filter dropdowns, scope selector, attribute filter, issue view storage,
  text draft state, project search query, project view surfaces, priority
  icon, state pill style). Keep the initial set small: just the filters
  needed for issues + projects.
- **`src/renderer/src/components/HulyIssueWorkspace.tsx`** — full‑page issue
  view; mirror `LinearIssueWorkspace.tsx`.
- **`src/renderer/src/components/HulyItemDrawer.tsx`** — drawer variant;
  mirror `LinearItemDrawer.tsx`.
- **`src/renderer/src/components/huly-*.tsx`** dialogs for create/update
  issue, add comment — mirror `linear-*.tsx` dialogs.
- **`src/renderer/src/components/huly-project-view-surfaces.tsx`** —
  project tab surfaces; mirror `linear-project-view-surfaces.tsx`.

---

## 9. Sidebar / workspace source / worktree linking

- **`src/renderer/src/components/sidebar/`** — add a Huly variant of the
  linked work‑item display (mirrors `sidebar/worktree-card-linear-issue-display.ts`).
- **`src/renderer/src/components/new-workspace/`** — surface the new
  `buildHulyWorkspaceSource` in the workspace source picker.
- **`src/renderer/src/components/worktree-creation/`** +
  **`launch-work-item-direct.ts`** — accept `provider: 'huly'` deep links
  (e.g. `ENG-123` style identifiers parsed from a `huly://` URL).

---

## 10. Mobile

- **`mobile/src/components/TaskProviderLogo.tsx`** — add `Huly` icon.
- **`mobile/app/h/[hostId]/tasks.tsx`** + **`mobile/app/index.tsx`** — add
  Huly source branches (mirror the Linear branches already there).

---

## 11. Tests and validation

- Unit tests colocated with each new module (§2, §3, §5, §6, §7 above).
- Integration: extend `src/renderer/src/components/settings/task-source-setup-state.test.ts`
  to include the `huly` entry.
- Manual — **local Orca**: connect to a Huly instance, list/create/update/
  comment on an issue, switch connection, verify cache isolation, verify
  mobile renders.
- Manual — **`orca serve`**: on a separate host, run `orca serve`, install
  `huly` CLI there, configure a Huly connection through the browser, and
  confirm list/create/update/comment work end-to-end. This validates the
  runtime RPC path and the server-side safeStorage + CLI spawn.
- Typecheck + lint as the final gate (commands live in `package.json`; verify
  by reading it).

---

## Out of scope (explicit)

- Webhooks / realtime push from Huly — Tasks page uses pull‑on‑render with
  TTL, matching Linear.
- Custom views — Linear has them; Huly has analogous "saved filters" but the
  CLI surface is thinner. Skip for v1.
- Sub‑issue hierarchy in the create flow — only render existing sub‑issues
  for v1.

---

## Open decisions

- **Auth storage shape**: Huly CLI accepts both `HULY_EMAIL`/`HULY_PASSWORD`
  and `HULY_TOKEN`. Plan stores the password OR token in safeStorage and
  re‑injects as env vars per invocation. If you want a dedicated "service
  account token" UX (like Linear's "paste API key"), the connect dialog
  surfaces the token field by default and tucks email/password behind an
  "advanced" disclosure. Confirm during implementation.
- **CLI install UX**: If `huly` is not on PATH **of the Orca server**, the
  integration card links to
  `npm i -g @iamcoder18/huly-cli` (the huly‑cli skill's preferred command)
  with copy clarifying it must be run on the server host. For `orca serve`
  the link should mention the server hostname from
  `activeRuntimeEnvironmentId` so the user runs it on the right machine.
  Decide whether Orca offers to install it for the user (Electron can
  spawn an installer) or only links out (simpler, safer — recommended for
  v1, since auto-installing on a remote host raises permissions
  questions).
