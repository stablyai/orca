# Mobile Workspace Source Selector

## Problem and goal

Desktop workspace creation already exposes source selection through `SmartWorkspaceNameField` (`src/renderer/src/components/new-workspace/SmartWorkspaceNameField.tsx:90`). Mobile `NewWorktreeModal` renders only Repository, Workspace Name, and Agent (`mobile/src/components/NewWorktreeModal.tsx:699`) and its create payload sends none of the source fields already accepted by `worktree.create` (`mobile/src/components/NewWorktreeModal.tsx:608`; schema at `src/main/runtime/rpc/methods/worktree-schemas.ts:62`).

Add an optional native **Start from** field with the same naming, branch-reuse, PR start-point, and linkage semantics as desktop. Reuse the existing runtime RPCs and `src/shared` functions; do not copy renderer logic or extend the current mobile-only naming/branch mirrors.

## Non-goals

- GitLab or another provider, cross-repository URL switching, or source creation.
- Provider credential setup inside the create sheet.
- Desktop composer changes or a new source-search RPC/cache.
- Immediate consistency with provider mutations hidden by the runtime's existing caches.

## Verified contracts and constraints

- `github.listWorkItems` returns `{ items, sources, errors? }`. Empty-query reads use the existing GitHub cache (up to 120 seconds). Issue-side partial errors may accompany valid PR rows. An empty-query PR-side failure rejects the RPC, but a queried PR-side failure is currently logged and returned as a missing PR subset without error metadata.
- `linear.status` returns the current connection/workspace metadata. `linear.searchIssues` returns an array. `linear.listIssues` returns `{ items, errors?, hasMore? }` on current hosts and may be an array on older hosts. Linear search and git-ref search can convert host/provider failures to an empty result, so the client cannot always distinguish “no matches” from a backend failure.
- `repo.searchRefs` returns `refDetails: { refName, localBranchName }[]` plus legacy `refs`. Exact local-branch reuse requires `refDetails`; do not infer reuse from legacy string rows.
- `worktree.resolvePrBase` returns `baseBranch`, `compareBaseRef`, `branchNameOverride`, optional `pushTarget`, and optional `maintainerCanModify`, or `{ error }`. It is not a free lookup: it fetches git refs and may query GitHub. A client timeout does not cancel that host work.
- All six source/read RPC methods above are already registered and mobile-allowlisted. Literal `sendRequest` calls are discovered by `mobile-rpc-allowlist.test.ts`; no production allowlist edit is expected.
- `resolveComposerBranchSelection` is only the first branch step. Desktop also uses `isBranchCheckedOutInWorktrees`, `resolveComposerBranchReuse`, `resolveComposerReuseOverride`, and `resolveComposerBranchNameOverrideForCreate`.
- Mobile Metro already watches `src/shared`, so `workspace-name.ts`, `composer-branch-selection.ts`, `linear-links.ts`, and their pure dependencies are directly reusable.

## Design

1. Add a static `mobile.workspace-source-selector.v1` runtime capability and pass the host capability list into `NewWorktreeModal`. Hide the optional field until capability state is loaded; omit it on older hosts. This fails closed because older `worktree.create` schemas may silently strip unknown optional linkage fields.
2. Keep `NewWorktreeModal` as wiring. Put RPC normalization, source-to-create mapping, name ownership, and request lifecycle state in focused named modules; add a dedicated `NewWorkspaceSourceDrawer` built from `BottomDrawer`, `MobileSearchField`, and `FlatList`. Pass `contentScrollable={false}` so `FlatList` owns scrolling instead of nesting inside the drawer's `ScrollView`. The already-grandfathered modal must not grow materially.
3. Extract the desktop smart-source 2 KiB UTF-8 query guard into `src/shared` and consume it from desktop and mobile. It is a UI safety bound, not an RPC/API limit. Debounce non-empty search by 200 ms, pass a limit of 12 to each backend, and cap the rendered mixed list to 12 rows.
4. Show All, GitHub, Branches, and Linear filters. GitHub and Branches are unavailable for folder repositories or a disconnected SSH target; Linear remains valid because its linkage is not repo-scoped. Read `linear.status` when the modal opens so a Linear-connected folder/disconnected-SSH repo can expose the field, refresh it each time the drawer opens, and omit Linear when disconnected. While the modal is open, consume the existing `runtime.clientEvents.subscribe` `sshStateChanged` event for the selected target (with `ssh.getState` as initial state), invalidate repo-backed reads on every transition, and expose GitHub/Branches again only after `connected`; do not add polling. Hide the field entirely when the selected repo has no available source kind.
5. Normalize only known envelopes. Drop malformed rows, preserve GitHub/Linear partial-error metadata, and treat a missing/malformed top-level collection as an incompatible-host error rather than a valid empty list. Legacy `repo.searchRefs.refs` may be shown only as “branch from” rows: mark them unverified and force their create-time `branchNameOverride` to `undefined`, so a local-looking legacy string cannot accidentally reuse an existing branch.
6. Track name ownership explicitly as `blank | source | user`. A selection replaces only `blank` or `source`; every keyboard edit becomes `user`, even when its text equals the suggestion. Clearing a source clears only a `source` name. A repo change clears GitHub/branch selection and its source-owned name, but preserves a Linear selection and all user-owned names.
7. Resolve a PR before committing the row selection. Keep the drawer open, guard the row with an immediate in-flight ref, and show a delayed spinner. On success store the full resolver result; on failure keep the prior selection unchanged. Extract and reuse the desktop fork-warning predicate: warn only when `maintainerCanModify === false` and `pushTarget` exists with a non-`origin` remote.
8. For a verified eligible local branch, show the desktop-compatible **Reuse existing branch** toggle and use `resolveComposerBranchReuse` for its default. Treat `selectionProducedOverride` as true only when the branch selection actually took ownership of a `blank` or `source` name; a `user` name must stay user-owned even when it prefixes the selected ref. Hide reuse for remote, unverified legacy, or known-busy branches. Preserve an enabled exact override across workspace-name edits; disabling it creates a fresh branch from the selected ref.
9. Feed the existing mobile create path through one pure candidate builder. Preserve setup, trust, SSH, agent, note, timeout, and collision behavior. On retries, suffix the workspace name and a fresh-branch/PR override together; keep a verified reusable local branch exact. Hand `worktree.displayName` from the successful response to `onCreated`/navigation, falling back to the candidate name only if it is absent, so an auto-managed display name is visible immediately. The runtime remains authoritative if another window or external git process wins the race.

## Data flow

- `status.get` capabilities plus repo kind, SSH state, and modal-open `linear.status` determine whether the field and filters exist.
- Drawer input passes the shared UTF-8 bound and debounce, then issues the eligible RPCs concurrently; normalized, generation-scoped results become rows.
- A row passes through source mapping, explicit name ownership, PR resolution or branch-reuse resolution, then the pure candidate builder feeds the existing `worktree.create` loop. Only its success response confirms the final branch/workspace.

### Source mapping

| Source | Name semantics | `worktree.create` additions |
| --- | --- | --- |
| GitHub issue | `getLinkedWorkItemWorkspaceName`, falling back to `issue-<number>` | `linkedIssue`; auto-managed `displayName` |
| GitHub PR | Same naming with `pr-<number>` fallback; full `resolvePrBase` result | `linkedPR`, `baseBranch`, `compareBaseRef`, `branchNameOverride`, `pushTarget`; auto-managed `displayName` |
| Linear issue | `getLinearIssueWorkspaceName` seed; `getLinkedWorkItemWorkspaceName` display from the Linear identity | `linkedLinearIssue`, `linkedLinearIssueWorkspaceId`, `linkedLinearIssueOrganizationUrlKey`; auto-managed `displayName` |
| Branch/ref | Full shared composer branch-selection/reuse pipeline | `baseBranch` and the create-time `branchNameOverride` when applicable |

Use the GitHub identity fallback for both the seed and auto-managed display name when the title has no sluggable characters, matching `getSmartGitHubSubmitResolution`; do not fall through to the unrelated blank-name creature. Derive the Linear organization key with `getLinearOrganizationUrlKeyFromIssueUrl`. Omit `displayName` after a user-owned name edit, matching desktop. Pass the selected repo ID to every repo-scoped RPC; do not trust or reuse a row's stale repo object.

## Request lifecycle and consistency

- Scope every response to `{ client epoch, modal open epoch, repo id, filter, query sequence, selection sequence }`. Closing/reopening, reconnecting, changing repo/filter/query/SSH state, clearing/changing a selection, or replacing the RPC client invalidates all older responses and PR resolutions.
- Generation guards suppress state commits; they do not cancel GitHub, Linear, git, or SSH work. Do not describe them as cancellation.
- Use an immediate ref guard for row selection and Create so two taps in one React turn cannot issue duplicate requests.
- Re-read repositories when the modal opens. If a repo is removed later, let the create RPC fail authoritatively, clear the stale repo on refresh, and retain the user's manual name.
- Treat provider rows and PR resolution as snapshots. A PR force-push after resolution still creates from the fetched SHA; a title/status change may remain cached. Reopening/retrying may refresh but must not promise immediate provider consistency.
- Use the current `worktree.ps` branch snapshot to avoid offering reuse for a known-busy local branch. External/unregistered worktrees and concurrent checkouts can still race; never promise exact reuse until the created worktree response confirms its branch.

## Edge cases, errors, and latency

- No source selected: creation and blank-name creature fallback are unchanged.
- Empty query in All: recent open GitHub work items plus assigned Linear issues. Do not query refs. Empty query in Branches: show a bounded ref list so the filter is useful without typing.
- Oversized query: issue no provider/git RPC and show inline validation.
- A GitHub title containing only non-sluggable characters still selects and creates with the deterministic `issue-<number>`/`pr-<number>` identity fallback.
- GitHub issue-side partial failure: render successful rows with the warning. RPC/contract failure: render an inline retry action; auth/tooling copy must name the selected host because `gh` runs there. A queried PR-side failure can only look like a missing subset with today's RPC contract, so use honest result/empty copy rather than fabricating a retryable error.
- Linear disconnected: omit the filter and rows. A disconnect after opening may fail or return empty; refresh status on the next modal/drawer open.
- SSH target transition: an `sshStateChanged` event immediately invalidates in-flight repo-backed reads and removes GitHub/Branches until the selected target is connected again; Linear availability is unchanged.
- Linear search and `repo.searchRefs` can mask backend errors as empty with today's RPC contracts. Use honest “No results” copy and retain this as a residual risk; do not fabricate an actionable provider error.
- PR resolution failure: keep the drawer and prior selection, show the error inline, and never fall back to the repo default branch.
- Known busy local branch: branch from the selected ref with no reuse override. Known reusable local branch defaults to exact reuse only when the branch selection took ownership of a blank/source-owned name.
- Folder repo: offer connected Linear only and hide the field otherwise. GitHub PRs and branches require a git repo.
- Use explicit 30-second timeouts for provider/ref/PR reads and the existing long create timeout. Disable immediately; show visible loading only after about 200 ms and keep row/button geometry fixed.

## Performance and blast radius

Source searches are initiated only while the drawer or a selection resolution is active; the lightweight `linear.status` availability read also runs when the modal opens. Already-started host work may finish after close. No polling, client cache, per-row lookup, or app-startup request is added. Omit GitHub `noCache` during normal search to preserve the runtime cache and rate-limit budget.

All mode is not one call: a settled query issues up to three concurrent RPCs (GitHub, Linear, refs). Internally, GitHub can perform separate issue/PR reads, Linear can fan out across connected workspaces, and slash ref queries can run two git probes plus an SSH capability fallback. Use a development transport counter/timer to record exact RPC fanout and raw cold/warm settled-result timings for representative All and Branches queries on local and connected SSH repos; do not claim percentiles from ad hoc samples or claim the debounce/generation guard makes this work free.

## Test plan

- Unit: exact GitHub, Linear, and ref envelopes; partial errors; malformed top-level rejection; legacy refs never enabling reuse; UTF-8 query bound.
- Unit: every source mapping, non-sluggable GitHub title fallback, Linear workspace/org metadata, fork warning, known-busy/reusable branches, create-time override resolution, retry candidates, and explicit name ownership.
- Component: capability gate, folder/disconnected-SSH source availability, live `sshStateChanged` disconnect/reconnect, filters, empty/loading/partial/error states, debounce, clear, duplicate-tap guards, keyboard/back behavior, and stale responses across query/filter/repo/close/client reconnect.
- Integration: exact `worktree.create` payload and returned-display-name navigation handoff for each source, including Linear on a folder repo; PR resolver failure; repo removal; manual-name preservation; no-source regression; setup/agent/collision behavior.
- Contract: runtime status advertises the new capability; all literal mobile RPCs remain registered and allowlisted. No Git compatibility-matrix change is needed because this feature adds no git command.
- Validation: focused Vitest, mobile and repository typecheck/lint, max-lines ratchet, an Expo production bundle, paired phone/emulator checks against local and SSH repos, and the development-only RPC-count/raw-timing evidence above. Provider validation must not mutate an issue/PR/Linear item.

## UI quality bar

Match the Repository and Agent field hierarchy, mobile tokens, 44-point touch targets, accessibility labels, disabled treatment, and drawer row geometry. Keep the Create action dominant; provider/type icons are secondary and row text must carry the meaning. `BottomDrawer` owns keyboard/safe-area movement and Android back dismissal. Do not add colors, type sizes, or elevation tiers.

## Review screenshots

Required, uncommitted device/emulator screenshots:

1. Create Workspace with the empty optional field at phone width.
2. Search drawer with keyboard visible, filters, and a mixed authenticated result set (or the honest available subset).
3. Collapsed selected PR or branch with its auto-owned name and any fork warning.
4. Deterministic oversized-query validation, or an available live provider partial/error state, with stable drawer geometry.
5. Adjacent Repository/Agent picker smoke showing correct top-drawer layering and a reachable Create action.

Manual-name preservation, stale suppression, exact payloads, and branch reuse are behavioral claims; prove them with tests/validation notes, not static screenshots.

## Rollout

1. Add the runtime capability and shared query bound, then cover mixed-version gating.
2. Add and test normalized source RPC, selection, name-ownership, branch-reuse, and create-candidate modules.
3. Add and test the native source drawer.
4. Wire the field, host capabilities, worktree branch snapshot, and source payload into the modal without materially growing the grandfathered file.
5. Run focused tests, typecheck, lint, max-lines ratchet, production bundle, performance audit, and paired mobile/Electron validation.

## Lightweight Eng Review

- **Scope:** one mobile field/drawer, pure shared/client modules, and one capability string; no provider mutation or new search backend.
- **Architecture/data flow:** native presentation owns transient state; runtime RPC owns host/provider/git work; `src/shared` owns naming and branch semantics; the runtime owns final conflict resolution.
- **Failure modes covered:** mixed versions, malformed/partial envelopes, auth/network loss, stale async work, repo removal, PR resolution, duplicate taps, and external branch races.
- **Test coverage required:** unit normalization/mapping/ownership/retry tests, component lifecycle/availability/interaction tests, exact-payload integration tests, and runtime capability/allowlist contracts.
- **Performance/blast radius:** bounded visible work with no polling, but All mode and PR resolution are multi-operation and must be measured locally and over SSH.
- **UI quality bar:** match adjacent mobile fields/drawers and `docs/STYLEGUIDE.md`; preserve touch targets, stable loading/error geometry, keyboard movement, and Create-action hierarchy.
- **Required review screenshots:** empty field, mixed search with keyboard, selected source, inline error/partial state, and adjacent-picker layering.
- **Residual risks:** Linear search/ref RPCs and queried GitHub PR reads can mask backend failures as missing results; GitHub results may be cached; provider and git state can change after selection.
