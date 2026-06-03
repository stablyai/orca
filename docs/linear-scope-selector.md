# Linear Scope Selector

## Problem

- `src/renderer/src/components/TaskPage.tsx:4368` renders workspace selection, "open in Linear", and team selection as separate controls even though they define one Linear issue-list scope.
- `src/renderer/src/components/ui/team-multi-combobox.tsx:127` offers only "All teams" plus team rows. When a team is absent, there is no affordance that explains whether the key is team-limited, the user lacks private-team access, the team is archived/retired, or the backend failed to fetch every page.
- Settings and onboarding both say a workspace is connected, but the connect copy only points to personal API-key settings. It does not explain full-access keys, team-limited keys, member API-key restrictions, or private-team access.
- The backend already supports the core scope model: `workspaceId === 'all'` fans out across stored Linear clients, and team list calls are routed through the same runtime APIs used for local and SSH sessions. The gaps are renderer UX plus stale/incomplete data handling.

## Goal

Make Linear task scoping feel like one selector:

1. Replace the separate workspace dropdown and team dropdown in the Tasks toolbar with one Linear scope popover.
2. Preserve the existing state model: `selectedWorkspaceId` is one workspace id or `all`; `defaultLinearTeamSelection` remains a nullable global list where `null` means sticky-all and an array means an explicit subset of team IDs.
3. Add an "Add team access" path from the selector. It opens a reusable API-key dialog. Pasting a key for an already connected workspace replaces that workspace token because the workspace id is stable.
4. Make the copy accurate: one full-access personal API key for a Linear workspace can cover every team the key owner can access in that workspace; restricted/team-limited keys only expose permitted teams; private teams require the key owner to be a member or otherwise have access.
5. Link to the most specific Linear settings URL Orca can build from `organizationUrlKey`, with global fallbacks when the workspace is unknown or `all`.

## Non-goals

- Do not change Linear authentication storage, encryption, IPC/RPC method names, or the `LinearWorkspaceSelection` type.
- Do not switch Linear auth to OAuth.
- Do not create, join, unarchive, or grant access to Linear teams from Orca. "Add team access" means paste a key whose owner/scope can already see the team.
- Do not make team selection per-workspace in this change.
- Do not touch provider-generic review code.

## Required Fixes Before UI

1. Fix team-list completeness.
   - `src/main/linear/teams.ts` currently calls `entry.client.teams()` once per workspace. The SDK query is paginated, so this can omit teams in larger workspaces.
   - Fetch all pages before the selector relies on team absence as a meaningful signal. Use `teams({ first })` plus `fetchNext()` until `pageInfo.hasNextPage` is false, or an equivalent raw GraphQL query. Keep the existing `MAX_CONCURRENT` limiter and do not set `includeArchived`; retired teams should stay absent.

2. Invalidate caches when a Linear key is connected or replaced.
   - Replacing a team-limited key with a full-access key must not leave the old `linearTeamCache` visible for up to `TEAM_CACHE_TTL`.
   - On successful `connectLinear`, synchronously clear Linear issue/search/team caches, in-flight issue/search/list/team requests, and metadata. Do this before publishing success, then await a forced status refresh before resolving so callers see the selected workspace and workspace list that came from the new key. The renderer `linearConnect` result is typed as `{ viewer }` only; do not rely on the main-process-only `workspace` field.
   - Guard `fetchLinearIssue()` and `listLinearTeams()` cache writes with a request generation or entry identity check. Clearing their in-flight maps is not enough today: those promises write unconditionally after resolution and can repopulate old issue/team data after key replacement. `searchLinearIssues()` and `listLinearIssues()` already use in-flight entry identity checks for forced refreshes; keep them covered by the same generation if connect/disconnect clears their maps.
   - Force a team refetch for the selected/connected workspace if the Linear Tasks view is open.
   - Issue list caches also need invalidation because changing key scope can add or remove visible issues.

3. Handle auth-driven token removal explicitly.
   - Backend calls can clear a workspace token on auth errors. In `all` workspace mode, `listTeams()`, `listIssues()`, and `searchIssues()` may return partial results instead of throwing.
   - After any auth-driven clear, the renderer must get a forced Linear status refresh or a typed signal so disconnected workspaces disappear without waiting for a later manual check. The current array-returning issue/search/team APIs have no signal for `all`-mode partial auth clears, so either add an auth-cleared result envelope end-to-end or force a metadata-only status refresh after `all`-workspace issue/search/team reads. Do not set `linearStatus` to globally disconnected from a single request error; refresh status because multi-workspace failures may only remove one workspace.
   - Strengthen `checkLinearConnection()` status equality. It currently compares workspace count, effective selected id, connected state, and viewer email. It misses active workspace id and workspace metadata changes when the count is unchanged. Compare a stable workspace signature including id, organization id/name/url key, display name, and email.
   - When a forced status refresh observes a changed selected workspace or workspace signature, clear issue/search/team caches, in-flight issue/search/list/team requests, and metadata. `checkLinearConnection()` currently only updates `linearStatus`, so removed workspaces can leave stale rows in `all` caches.

4. Be honest about team filtering.
   - Current Linear issue reads do not accept team IDs; team selection filters the already-limited issue/search result in the renderer after the `LINEAR_ITEM_LIMIT` page arrives. In `all` workspace mode, each workspace may fetch up to the limit, but the backend aggregates and trims back to `LINEAR_ITEM_LIMIT` before the renderer filters by team.
   - This UI change should not imply exhaustive server-side team scope. Empty task states must say no fetched/current issues match the selected teams. True server-side team scoping needs a separate change to add team IDs to cache keys, runtime RPC params, and Linear GraphQL filters.

## Design

1. Add URL helpers in `src/shared/linear-links.ts`.
   - `buildLinearPersonalApiKeySettingsUrl(organizationUrlKey?: string | null)` returns `https://linear.app/<slug>/settings/account/security` when a slug exists, otherwise `https://linear.app/settings/account/security`.
   - `buildLinearWorkspaceApiSettingsUrl(organizationUrlKey?: string | null)` returns `https://linear.app/<slug>/settings/api` when a slug exists, otherwise `https://linear.app/settings/api`.
   - Encode path segments consistently with `buildLinearTeamUrl`.

2. Add `LinearApiKeyDialog` in `src/renderer/src/components/linear-api-key-dialog.tsx`.
   - Props: `open`, `onOpenChange`, optional `workspace`, optional `title`, optional `description`, optional `connectLabel`, optional `onConnected`, optional `overlayClassName`/`contentClassName`.
   - Own input, connecting/error state, Enter-to-submit, and `connectLinear`. Fire `onConnected` only after `connectLinear` resolves with refreshed store status.
   - Use org-specific URLs only when a single workspace context is known. For `all`, use the global fallback and copy that tells the user to choose the intended Linear workspace.
   - Guidance:
     - Create a Personal API key from Account > Security & Access.
     - Prefer full access when Orca should show every team the account can access in that workspace.
     - If member API keys are blocked, ask a workspace admin to allow them from workspace API settings. Do not imply the workspace API page creates the personal key.
     - A key never grants teams the owner cannot access.
   - Make storage copy runtime-aware. Local runtime keys use the local OS keychain when Electron encryption is available; SSH/remote-runtime keys are stored by that runtime, not necessarily on this machine.

3. Replace the Tasks toolbar Linear controls with `LinearScopeSelector`.
   - Suggested file: `src/renderer/src/components/linear-scope-selector.tsx`.
   - Keep state updates in `TaskPage`: workspaces, selected workspace id, teams, selected team ids, callbacks for workspace select, team select, select-all teams, open selected team URL, and open API-key dialog.
   - Trigger label examples:
     - One workspace + sticky-all: `All teams`
     - One workspace + subset: `ENG, STA +1`
     - Multiple workspaces + `all` + sticky-all: `All workspaces`
     - Multiple workspaces + one workspace + sticky-all: `<Workspace name> / All teams`
     - Multiple workspaces + subset: `<Workspace name> / ENG, STA +1` or `All workspaces / ENG +1`
     - If the active scope is `all` and selected team keys are duplicated or span multiple workspaces, prefer `All workspaces / 2 teams` over an ambiguous key list.
   - Popover content:
     - Search filters team rows by team name, team key, and workspace name.
     - Workspace section appears only when more than one workspace is connected. It includes "All workspaces" and each workspace.
     - Selecting a workspace must call the existing `selectLinearWorkspace` flow, clear selected issue/list/error/loading state the same way `TaskPage` does now, and must not mutate `defaultLinearTeamSelection`.
     - Team section includes "All teams" and selectable team rows. "All teams" persists `defaultLinearTeamSelection: null`; explicit subsets persist an array. Normalize a selection equal to all available teams back to `null`, even if the user selected teams one by one. Never persist an empty array; keep the last team selected or save `null`.
     - Team rows show name, key, and workspace name when active workspace is `all` or when multiple workspaces exist.
     - Footer has "Add team access" with a key/link icon. Close the popover before opening the API-key dialog.
     - Keep the external-link button as an icon-only sibling. It remains an action, and should stay enabled only when exactly one selected team has a URL.

4. Keep team selection reconciliation, but document its limits.
   - `reconcileLinearTeamSelection()` preserves sticky-all and drops stale team IDs.
   - Because the saved team subset is global, switching workspaces may temporarily select all teams in the new workspace while preserving the old saved subset for later. Do not introduce per-workspace persistence here.

5. Update Settings and onboarding to use `LinearApiKeyDialog`.
   - Rename "Add workspace" to "Add Linear access" when disconnected and "Update access" or "Add workspace access" when connected.
   - Replace "Each workspace uses its own locally stored API key" with copy that says each connected Linear workspace has one key stored by the active runtime; a full-access key can cover all visible teams in that workspace, and a restricted key can be replaced any time.
   - Keep existing per-workspace Test and Disconnect controls.

## Edge Cases

- No Linear workspaces connected: no Tasks selector; Settings/onboarding still show Connect.
- One workspace connected: hide the workspace section, but keep "Add team access" visible.
- Multiple workspaces + `all`: team keys/names can repeat across workspaces; always show workspace names in rows.
- Empty team result: show an empty state plus footer action. Do not claim the key is the only possible cause; absence can also come from private-team membership, archived teams, permissions, or a fetch failure.
- Empty issue result after team selection: say no fetched/current issues match the selected teams. Do not imply Linear was queried exhaustively for those teams.
- Legacy or missing `organizationUrlKey`: use global Linear settings URLs and keep the paste flow usable.
- Replacement key for an existing workspace: select that workspace, invalidate caches, refresh status, and refetch teams immediately.
- Auth errors: a backend call may clear a token. The selector must tolerate stale rows during the refresh, then drop disconnected workspaces when status updates.
- Multi-window/external mutations: there is no real-time renderer broadcast. Force `checkLinearConnection(true)` after connect/disconnect/test flows and when opening the selector if stale status would be visible. Forced refresh must still update state and invalidate caches when workspace metadata changed but the workspace count did not. A same-workspace key replacement with identical viewer/workspace metadata is invisible to status today; do not claim that case is handled unless this change adds a non-secret credential revision or a renderer broadcast.
- Remote runtime/SSH: continue routing through `connectLinear`, `selectLinearWorkspace`, `listLinearTeams`, and runtime RPC. Do not call local Electron APIs directly except for opening Linear URLs.
- Accessibility: trigger is a combobox-style button, rows are keyboard-selectable, icon buttons have labels/tooltips, and the dialog traps focus.

## Tests

- `src/shared/linear-links.test.ts`: URL helpers, fallback behavior, and path encoding.
- `src/main/linear/teams.test.ts`: paginated team fetching and `all` workspace aggregation.
- `src/renderer/src/store/slices/linear.test.ts`: successful connect invalidates issue/search/team caches, drops stale in-flight writes, awaits refreshed status, and does not mark all Linear disconnected for one workspace auth failure.
- `src/renderer/src/store/slices/linear.test.ts`: forced status refresh detects changed workspace ids/metadata with the same workspace count and invalidates Linear caches when the scope signature changes.
- Component-independent label and selection-persistence helper tests for `LinearScopeSelector`, including selecting every visible team persisting sticky-all (`null`) rather than a frozen full-team array.
- Avoid brittle popover DOM tests unless matching an existing selector test pattern.

## Rollout

1. Fix backend/store correctness: team pagination, connect invalidation, and auth-clear status refresh.
2. Add Linear settings URL helpers and tests.
3. Add `LinearApiKeyDialog`; migrate Settings, onboarding, and the existing Tasks connect dialog.
4. Add `LinearScopeSelector` and replace only the Linear toolbar selector block in `TaskPage`.
5. Run focused Linear tests, then `pnpm typecheck` and `pnpm lint`.
