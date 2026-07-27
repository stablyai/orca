# Issue #10620: Existing-Folder Project Identity Reconciliation

## Problem

GitHub issue [#10620](https://github.com/stablyai/orca/issues/10620) reports that adding an
existing clone as another host setup can fail with:

`Imported folder does not match the selected project identity.`

The selected project projects to `git:<canonicalKey>`, while the stored repo projects to
`repo:<repoId>`. Both checkouts can have the same current remote and commit, but
`alignRepoWithRequestedProject` compares only persisted projections and rejects generic Git
projects without re-reading the folder.

The policy is duplicated in:

- `src/main/ipc/repos.ts` (`alignRepoWithRequestedProject`) for local and SSH-backed imports.
- `src/main/runtime/orca-runtime.ts` (`setupProjectExistingFolder`) for runtime-host imports.

Two distinct causes produce the same message, and a fix must handle both:

- **Stale/missing `gitRemoteIdentity` on the existing record.** `addLocalRepoFromPath` /
  `addRemoteRepoFromPath` / runtime `addRepo` return an already-stored repo unchanged, so
  `detectRepoIconAndUpstream` never re-runs. Fresh imports usually work because that probe runs
  before the repo is stored.
- **Asymmetric GitHub metadata across hosts.** `upstream` and the GitHub avatar icon come from
  `getRepoUpstream` / `getRepoSlug`, which need GitHub API or `gh` credentials _on the host that owns
  the repo_. A clone on a host without them settles at `git:<canonicalKey>` while the same
  repository on a credentialed host settles at `github:<slug>`. Re-probing the remote cannot fix
  this, because GitHub metadata outranks `gitRemoteIdentity` in projection precedence.

`git remote -v` output is identical in both cases, which is why the report shows matching remotes
and commits.

## Goal

Before rejecting a mismatched existing Git folder, synchronously re-probe its current remotes on the
host that owns the repo, and decide acceptance from **canonical remote keys**, not from projected
project ids. Persist the authoritative result on acceptance only; a rejected import must leave the
store exactly as it found it.

The same identity and failure policy must apply to local, SSH, and runtime-host setup paths.

## Non-goals

- Do not compare commits, branches, working-tree contents, or filesystem paths as project identity.
- Do not merge projects whose canonical remote identities differ.
- Do not redesign project/setup projection or its `github:`, `git:`, and `repo:` keys.
- Do not re-key an existing project, even when its identity source later resolves.
- Do not change background identity-enrichment retry policy.
- Do not change clone, folder-workspace, or non-Git folder semantics.
- Do not add provider-specific behavior for GitLab or other generic Git hosts.
- Do not clear or overwrite existing GitHub metadata (`upstream`, `repoIcon`) to force a match.

## Ground Truth

Verified against the current tree; an implementer can rely on these.

- `getProjectHostSetupForRepo(setups, repo)` returns the persisted setup for `repo.id`, else a
  single-repo projection. `Store.updateRepo` calls `syncProjectHostSetupCompatibilityState`, so
  `store.getProjects()` / `store.getProjectHostSetups()` reflect a write immediately.
- Projection precedence in `getProjectIdentityKey` is: GitHub provider identity (`upstream`, then a
  `github`-sourced `repoIcon` label, then a GitHub-recognizable `gitRemoteIdentity.remoteUrl` /
  `canonicalKey`) → complete `gitRemoteIdentity` → `repo:<repoId>`.
- `Project` carries both `providerIdentity` and `gitRemoteIdentity` when its identity source repo
  had them. A project whose id starts with `repo:` has neither.
- `probeGitRemoteIdentity(path, connectionId)` distinguishes:
  - `resolved`: Git returned a usable canonical remote identity.
  - `no-remote`: Git was reached but returned no usable remote.
  - `unavailable`: Git or the owning host could not be reached (includes "SSH provider not
    registered", because `getSshGitProvider` returns `undefined`).
- The probe's `identity` is **one** primary remote — `upstream`, then `origin`, then alphabetical —
  and before §1 every other remote was discarded. Two clones of the same project legitimately differ
  here (a fork checkout has `upstream` + `origin`; a plain clone has only `origin`).
- `normalizeGitRemoteUrl` lowercases the host, strips `.git` and surrounding slashes, preserves path
  case, and returns `null` for drive-letter and other non-URL local paths — such repos settle as
  `no-remote`.
- `githubRepoIdentityKey` lowercases `owner/repo` and omits the default `github.com` host.
- `git remote -v` predates the Git 2.25 baseline; no `GitCapabilityCache` entry is needed.
- Background enrichment (`repo-git-remote-identity-enrichment.ts`) only considers repos where
  `!repo.gitRemoteIdentity`, and `isSameUnenrichedRepo` re-checks that before writing. **A stale
  non-null `gitRemoteIdentity` is never refreshed by any background path.**

## Design

### 1. Extend the probe to return every canonical remote

Add `remotes: GitRemoteIdentity[]` to the `resolved` variant of `GitRemoteIdentityProbe`: every
remote that has a usable canonical key, in primary-remote precedence order (`upstream`, then
`origin`, then the rest by name), so `remotes[0]` is exactly today's `identity`. Build it from the
already-exported
`parseGitRemoteVerboseOutput` / `normalizeGitRemoteUrl`; no extra Git call. `identity` keeps its
current meaning and `detectGitRemoteIdentity` is unchanged, so enrichment and repo creation are
unaffected.

Dedupe on `canonicalKey` **plus** `remoteUrl`, not on `canonicalKey` alone. Two different remotes can
share one canonical key and still differ in the part that decides the project: `normalizeGitRemoteUrl`
is port-blind, so a GHES endpoint port survives in the URL alone, and the exact spelling is what gets
persisted. (Push lines never reach the dedupe — `parseGitRemoteVerboseOutput` keeps `(fetch)` only.)

Acceptance compares the whole set; persistence writes exactly one entry from it (§4), so projection
still sees a single `gitRemoteIdentity` and is untouched.

Bound the probe: pass `timeoutMs` to `IGitProvider.exec` and `timeout` to `gitExecFileAsync`
(3 seconds). A timeout resolves to `unavailable`. This is required — the renderer gives
`projectHostSetup.setupExistingFolder` a 15 s runtime RPC budget
(`src/renderer/src/store/slices/repos.ts`), and the local/SSH IPC invoke has no timeout at all, so an
unbounded SSH exec would hang the import.

The 3 s bounds the probe, not Git's own runtime, and everything the probe waits on is inside it:
locally it is `execFile`'s `timeout`, so a Windows/WSL host pays `wsl.exe` cold start out of the
budget; over SSH it bounds the relay round trip on an already-connected provider (an unregistered
provider resolves `unavailable` immediately, without waiting for a reconnect). The relay bound covers
the request up to its sentinel, so it is the whole wall clock only while output stays under the
256 KiB streaming threshold — true for `git remote -v`, and the reason this budget must not be reused
verbatim for a large-output command, which would fall to the 30 s stream inactivity timeout. A cold host can
therefore exhaust the budget and have a perfectly good folder reported as unreadable (§6), with the
retry landing on a warm host. That is the accepted trade-off: the same 15 s RPC budget also covers
`addRepo`'s own validation and upstream detection, so giving the probe most of it would convert a
legible, retryable rejection into an opaque RPC timeout.

### 2. Centralize reconciliation

Add an async main-process module `src/main/project-host-existing-folder-reconciliation.ts`.

It accepts:

- a store port: `getProjects()`, `getProjectHostSetups()`, `getRepo(id)` (re-reads the record the
  probe `await` may have raced — see step 7), `updateRepo(id, updates)`,
  `restoreRepoIdentityFields(id, restore)` (rollback only — see step 7);
- the repo returned by the import/add path;
- the requested `projectId`;
- the requested setup method;
- the execution host id this process owns (see §5).

It returns the existing `ProjectHostSetupResult` shape. Both IPC and runtime setup methods await
this function instead of maintaining separate alignment branches.

Steps:

1. Project the repo. If `setup.projectId === projectId`, skip to step 7.
2. Resolve the selected project from `getProjects()`. Reject if it no longer exists.
3. Compute the selected project's **canonical remote key** (§3). If it has none — its id starts with
   `repo:` — reject with `project_identity_unresolved` (§Failure Contract) and write nothing.
4. If the stored repo record's `kind` is `folder`, skip the probe and go to step 6. Use the returned
   record's `kind`, not the request's `args.kind`: an existing record is returned regardless of the
   requested kind.
5. Otherwise probe the repo (§5) and apply §4.
6. Apply the GitHub compatibility fallback (§6) when it is still needed.
7. Write the planned identity updates and `projectHostSetupMethod`, rebuild the projected
   setup/project, and return.

Steps 4–6 only **plan** the repo updates; nothing is written until step 7 decides the import is
accepted. This is what makes §7's "a rejected import writes nothing" reachable: §4 can select
a matching remote that §6 then still rejects, so persisting at §4 would leave a write behind on a
rejected import. Planning is close to exact because `mergeProjectHostSetupCompatibilityState` drops
every persisted repo-backed setup and re-emits `projectHostSetupProjectionFromRepos(repos).setups` on
each read — so `getProjectIdentityKey({ ...repo, ...plannedUpdates })` predicts the post-write setup
for everything the store persists verbatim.

It is a prediction, not a guarantee. The plan runs against the hydrated record the add path handed
back, while the store projects from its raw records, and `updateRepo`'s sanitizers can keep less than
the plan asked for — a dropped GHES `upstream.host` re-keys the repo onto the same-named github.com
project. Hydration can also keep less than the projection reads: `sanitizeRepoIcon` drops a malformed
or oversized icon that `getProjectProviderIdentity` still derives an identity from, so that record's
plan and projection disagree permanently, with no concurrent writer involved. Step 7 therefore re-reads the store's own projection after the write and, when it disagrees,
restores the identity fields to their exact pre-write state (including back to _absent_, which
`updateRepo` cannot express — hence the narrow `Store.restoreRepoIdentityFields`) before rejecting.

After every store update, re-read the repo record; a missing record throws the existing
disappeared-record error. Use the returned record for the next projection.

### 3. Canonical remote key of a project

Provider-neutral, and the only comparison used for accept/reject:

```
projectCanonicalKeys(project) =
  [ project.gitRemoteIdentity?.canonicalKey ]                              // exact match
  ∪ [ `${host ?? 'github.com'}/${owner}/${repo}` from providerIdentity ]   // case-insensitive match
```

Compare `git:`-sourced keys byte-for-byte (path case is significant on generic Git servers). Compare
the `providerIdentity`-derived key case-insensitively, because `githubRepoIdentityKey` already
lowercases the slug while `normalizeGitRemoteUrl` does not.

The `git:` entry earns its keep only when the project is keyed `github:` while still naming a generic
remote — a record carrying both GitHub metadata and a generic key. For a project keyed `git:`, the
projection gate below re-derives the same key from the planned record and would refuse a case-variant
anyway, so the entry is redundant there.

A repo matches the project when **any** entry of `probe.remotes` matches **any** project canonical
key.

### 4. Resolved-probe policy

Let the **matching remote** be the first entry of `probe.remotes` whose canonical key matches a
project canonical key (§3).

- **A matching remote exists** → plan _that_ entry as `gitRemoteIdentity`, recompute the projection
  from the planned record, and continue. Select the matching remote, not `remotes[0]`: a fork
  checkout's primary remote is `upstream`, so writing the primary would land the repo in a third
  project and fail the projection check even though the repo genuinely belongs to the selected
  project.
- **A matching remote exists but the recomputed projection still disagrees** — the same remote lands
  in different namespaces because one side carries GitHub metadata and the other does not (the GHES
  case in the second problem cause). Do **not** reject. Fall through to §6.
- **No matching remote** → reject with the existing user-facing mismatch message, and **write
  nothing** (§7).

This write may move an already-identified repo out of a stale project into the selected one. That is
the intended repair — the user explicitly asked to attach this folder to the selected project, and a
wrong stored identity is one of the two named causes. It is also why §7 requires a repos-changed
notification: the move can drop the old project row via
`mergeProjectHostSetupCompatibilityState`.

Because that move can also strand `WorktreeMeta.projectId` values previously stamped by
`getProjectHostSetupWorktreeMeta`, an accepted repair re-stamps every already-stamped meta row of
that repo (`<repoId>::…` keys) from the fresh projection, inside the same store write/notify cycle as
the identity write. Rows that were never stamped stay untouched — legacy state this flow has no
mandate to start owning — and a rejected import remaps nothing.

`no-remote` plans the settled `null` marker only when the repo has no usable stored identity —
i.e. `getProjectIdentityKey(repo)` currently returns a `repo:` key — then continues to §6; like
every other planned update it is written only if the import is accepted. Never
clear a stale non-null identity with the `null` marker: that demotes the repo to `repo:<repoId>`,
drops it out of its current project, and cannot help the current action anyway, since a `no-remote`
repo can only link through §6.

`unavailable` preserves the stored identity and continues to §6.

### 5. Host routing

Derive the probe host from `getRepoExecutionHostId(repo)`, never from path syntax and never from
"normally has no `connectionId`":

- `local` → probe with no `connectionId`.
- `ssh:<targetId>` → probe with the `targetId` decoded out of the host id the ownership check just
  cleared, **not** `repo.connectionId`: on a record whose two fields disagree, `connectionId` would run
  Git on a machine this import was never authorized for. No local Git command may inspect an SSH path.
- `runtime:<envId>` → only the runtime service that owns that environment may probe, and it probes
  its own local filesystem.

If the record's execution host is not the one this process owns, do not probe: treat it as
`unavailable`. This matters because `addLocalRepoFromPath` matches existing records on
`!repo.connectionId && path`, which can return a runtime-stamped record.

Reconciliation runs its own probe rather than reusing the enrichment module's
`inFlightProbesByLocation` / `noIdentityRetryAfterByLocation` maps, so a recent `no-remote` TTL
cannot make a user action return a stale answer. The enrichment writer is already safe against this
race: `isSameUnenrichedRepo` refuses to write once `gitRemoteIdentity` is truthy, so a late
background probe cannot clobber the setup write.

### 6. GitHub compatibility fallback

The existing flow associates a repo lacking a usable GitHub identity with a selected GitHub project
by persisting that project's `providerIdentity` as `upstream`. Keep it, gated on:

- the selected project has a GitHub `providerIdentity`; **and**
- the probe did not resolve a canonical key that conflicts with the project (§4 already rejected
  those), i.e. the probe was `no-remote`, `unavailable`, a folder record, or a resolved match; **and**
- the repo has no settled identity of its own that names somewhere else. The fallback links a folder
  without a positive remote match, so a stored `gitRemoteIdentity` whose canonical key sits outside
  the project's key set rejects instead: a Git that Orca could not read is no evidence the folder
  belongs here. Only empty, `repo:`-keyed, or matching identities can be linked blind.

Generic Git projects never synthesize identity from the selected project.

If the fallback does not apply and projection still disagrees, reject:

- selected project is generic (`git:`) and the repo carries GitHub metadata that outranks it →
  `repo_github_metadata_outranks_project`. Do not clear the repo's GitHub metadata to force a match.
- otherwise → the existing mismatch message.

After applying the fallback, recompute the setup and require it to match the requested project.
Never report success merely because an update was attempted.

### 7. Side effects and ordering

- Write `projectHostSetupMethod` only after identity reconciliation succeeds. A rejected import must
  not mark the repo as an imported/cloned setup for the selected project.
- A rejected import writes **nothing through reconciliation** (see §4): no identity field and no
  setup method survive it. The previous draft of this design allowed a rejected import to refresh
  stale identity metadata; that is unsafe, because the refresh itself can re-project the repo into a
  different project. What reconciliation cannot undo is the add path in front of it: a first-time
  import keeps the record `addLocalRepoFromPath` created, including the
  `projectHostSetupMethod: 'imported-existing-folder'` that path stamps on new git repos. That record
  projects to its _own_ project, never the rejected one, so the bullet above still holds — and
  deleting it would discard a folder the user did add.
- Notify **after** reconciliation, not before. Today `projectHostSetups:setupExistingFolder` calls
  `invalidateAuthorizedRootsCache()` + `notifyReposChanged(mainWindow)` _before_
  `alignRepoWithRequestedProject`, and the runtime `setupProjectExistingFolder` emits nothing on the
  already-existed path. Reconciliation now changes project membership, so both entry points must
  emit a repos-changed notification (and the runtime must also call
  `invalidateResolvedWorktreeCache()`) after a successful reconciliation. Without it the renderer
  keeps a ghost project row: `setupProjectExistingFolder` in `src/renderer/src/store/slices/repos.ts`
  patches by `result.project.id` and cannot represent a removed project.
- Do not emit twice for one import. The runtime's `addRepo` already broadcasts when it creates or
  host-adopts a record, so the runtime entry point compares the pre-add repo ids and execution hosts
  against the returned record and, when `addRepo` announced, notifies again only if reconciliation
  actually rewrote `upstream`/`gitRemoteIdentity` (`didReconciliationChangeRepoIdentity`). The setup
  stamp alone needs no second broadcast: it is already in the returned result.
- A rejection still notifies in two cases, and only those. First, when the add path _created_ a repo
  record (`!result.alreadyExisted`): that record exists whatever reconciliation decides, and moving
  the notification after reconciliation would otherwise strand it unannounced. Second, when the
  rejection itself mutated the store — a write that was rolled back still bumped the compatibility
  state and the save, so clients hold a record that no longer matches. Reconciliation reports that
  through `ExistingFolderReconciliationError.storeChanged`, read via `didReconciliationChangeStore`,
  so neither entry point has to infer it from the message. A rejected import of an already-known repo
  that never reached a write stays silent.
- Keep the rest of the caller-owned side effects unchanged: `emitRepoAdded` where it is, and
  `prepareLocalWorktreeRootForRepo` for an already-existing repo after successful alignment (it
  self-guards non-local and folder repos).

### 8. Runtime store adapter

`RuntimeStore` declares `getProjects`, `getProjectHostSetups`, and `updateProject` as **optional**.
The adapter passes `listProjects()` / `listProjectHostSetups()` (which already fall back to `[]`) and
reports `runtime_unavailable` when the store lacks any capability this flow needs — `getProjects`,
`getProjectHostSetups`, or `restoreRepoIdentityFields`. Gate on the capability being _present_, not on
the projects list being empty: an empty list is a legitimate "no projects yet", while a store that
cannot roll back cannot honor §7's rejected-import contract at all. Check it **before** `addRepo`, so a
missing capability cannot leave an orphan repo record behind.

The runtime service owns exactly the host it was addressed as, and that host is never `ssh:`. It reads
and validates the path on its own filesystem, so accepting an `ssh:` host id would stamp a remote host
onto a record inspected here and then send the identity probe to that remote machine. Reject those with
a message pointing at the desktop `projectHostSetups.setupExistingFolder` IPC, which is the entry point
that owns SSH hosts.

## Failure Contract

| Condition                                                        | Outcome                                                                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| A probed remote matches a project canonical key                  | persist that remote, link, return success                                                         |
| Resolved probe, no probed remote matches                         | reject with `Imported folder does not match the selected project identity.`; write nothing        |
| Selected project id starts with `repo:`                          | reject with `project_identity_unresolved`; write nothing                                          |
| Selected project generic, repo has outranking GitHub metadata    | reject with `repo_github_metadata_outranks_project`; write nothing                                |
| `no-remote`, repo has no usable stored identity                  | persist `null` if the fallback links it, else write nothing; only the GitHub fallback may link it |
| `no-remote`, repo has a stored identity                          | keep the stored identity; only the GitHub fallback may link it                                    |
| `unavailable`                                                    | keep the stored identity; only the GitHub fallback may link it; blames the unread remote          |
| Repo disappears mid-reconciliation                               | throw the existing disappeared-record error                                                       |
| Selected project disappears, or planned projection still differs | reject without writing identity or setup metadata                                                 |

These throw plain `Error`s from the main/runtime process; the renderer surfaces `error.message`
verbatim as a toast description, so the text is user-facing and stays unlocalized like the existing
message:

- `project_identity_unresolved` → `The selected project has no resolved remote identity yet. Open
its existing host so Orca can read that repository's remote, then try again.`
- `repo_github_metadata_outranks_project` → `This folder is already linked to a GitHub repository, so
it cannot join a non-GitHub project.`
- `project_identity_remote_unreadable` → `Orca could not read this folder's git remote from its host,
so it cannot confirm the folder belongs to the selected project. Open the folder on its own host and
try again.`

The remote is the identity boundary. Same path, folder name, or HEAD does not make two repos the
same project.

## Known limitations (explicitly out of scope)

State these so the implementer does not invent policy for them.

- **Folder projects cannot be added to another host.** A folder repo has no `gitRemoteIdentity` and
  no `upstream`, so its project id is always `repo:<repoId>`; step 3 rejects with
  `project_identity_unresolved`. This is today's behavior with a clearer message. Multi-host folder
  projects need a projection change and are tracked separately.
- **A project keyed `repo:<repoId>` is never repaired by this flow.** Its identity source repo may
  live on a host this process cannot reach, and repairing it would re-key the project — an explicit
  non-goal. The user's remedy is to open the source host so background enrichment settles it.
- **Duplicate ready setups for the same `(projectId, hostId)`** are possible when two clones of one
  repository live on one host. This is pre-existing projection behavior: `createProjectHostSetup`
  guards duplicates, but the repo-projection path that mints setups never runs that guard. Do not
  add dedupe here.
- **Stale non-null identities are only repaired by this flow**, because background enrichment skips
  them. A repo whose remote was re-pointed keeps a stale project grouping until the user runs setup
  against it.
- **GitHub host spellings the projection cannot fold.** `isGitHubRemoteHost` treats a `github-*` host
  as its own GitHub host, so a clone whose remote goes through an ssh-config alias such as
  `git@github-work:acme/orca.git` keys into a different project than the same repository cloned
  through `github.com`, and step 4 rejects the import instead of stamping it. Folding them would mean
  accepting a host the probe never saw as equal to one it did, which is indistinguishable from a
  genuinely separate Enterprise instance serving the same `owner/repo` slug. The mismatch is the
  weaker failure, so it stands.

## Concurrency and Consistency

- Re-probing is synchronous within the user action, so background enrichment is never required for
  correctness.
- The probe is bounded (§1) and degrades to `unavailable`, which is a link-refusing but non-throwing
  state.
- A remote can change between probe and persistence. This patch adds no Git/store transaction; the
  next setup attempt reconciles a later change.
- Persisting the probe result makes subsequent projection consumers observe the same decision setup
  made.
- Cost is one `git remote -v` per setup attempt, only when the persisted projection initially
  mismatches the selected project.

## Tests

Reconciliation unit tests (`src/main/project-host-existing-folder-reconciliation.test.ts`):

- stale `null` identity plus a matching current remote succeeds and persists the identity;
- missing identity plus a matching current remote succeeds;
- equivalent scp-like and `ssh://` URLs group under the same canonical project;
- a stale **non-null** identity plus a matching current remote succeeds and overwrites it;
- a fork checkout whose primary `upstream` remote differs but whose `origin` matches the project
  links, and persists the matching `origin` remote rather than the primary;
- a resolved different remote rejects, writes no identity, and writes no setup metadata;
- `no-remote` does not clear a stale non-null identity;
- `no-remote` and `unavailable` reject generic Git linking;
- a `repo:`-keyed selected project rejects with `project_identity_unresolved` and writes nothing;
- GitHub fallback still links a GHES project when the probe resolves the project's canonical key but
  the repo lacks GitHub metadata;
- GitHub fallback rejects a resolved conflicting remote;
- a generic project plus a repo with outranking GitHub metadata rejects without clearing it;
- folder records do not invoke the Git probe;
- the probe timeout constant stays far inside the 15 s setup RPC budget it is awaited within;
- a rejected import restores the exact pre-write state of both identity fields — back to absent, and
  back to a settled `null` marker — including collateral fields the store's own writer added, and
  leaves an unrelated enrichment that landed during the probe in place;
- a rejection reports whether it mutated the store, and a rejection with nothing to write touches
  neither `updateRepo` nor the rollback;
- host routing: a record owned by another host (local, or a different SSH target) is never probed and
  is blamed as unreadable rather than mismatched; a locally owned record with a stale `connectionId`
  probes locally; an SSH-owned record probes through the target decoded from its host id, not through a
  divergent `connectionId`;
- generic `git:` keys stay case-sensitive while provider slugs match case-insensitively;
- a probe that confirms the stored identity writes no identity update at all.

Entry-point integration coverage:

- `src/main/ipc/repos-remote.test.ts` — local IPC passes the existing repo through reconciliation,
  prepares roots only after success, and notifies after reconciliation; SSH IPC probes through the
  matching connection and never runs local Git for the remote path; the existing
  "preserves the selected Enterprise host when aligning an existing folder" case still passes.
- `src/main/runtime/orca-runtime.test.ts` — runtime setup refreshes an existing repo and returns the
  requested projected setup; runtime repos with identical paths but different runtime owners stay
  isolated; a repo whose execution host this process does not own is not probed; an `ssh:` host id is
  refused before any record is created; a store without the rollback capability reports
  `runtime_unavailable` before `addRepo` runs; a rejection that wrote and rolled back still
  re-announces. These run real Git, so they go through `isolated-git-repo-fixture.ts`: an ambient
  `url.<base>.insteadOf` (or a leaked `GIT_CONFIG_COUNT`) rewrites what `git remote -v` prints, which
  is exactly the value under assertion. The store fake projects with the real
  `projectHostSetupProjectionFromRepos` and mirrors the delete-on-`undefined` rollback, so a test
  cannot pass against a projection the product does not use.

Retain `src/shared/project-host-setup-projection.test.ts`, `src/shared/git-remote-identity.test.ts`,
and `src/main/repo-git-remote-identity*.test.ts` for provider precedence, remote URL forms, the
bounded probe degrading a timeout to `unavailable` rather than throwing, and the unchanged enrichment
contract.

## Validation

1. Run the reconciliation, IPC setup, runtime setup, remote canonicalization, and project-host
   projection suites.
2. Run typecheck and lint for the changed modules.
3. Repeat the Electron reproduction with two clones of the same generic remote:
   - seed the second repo record with stale or missing `gitRemoteIdentity`;
   - import it as an existing folder for the first clone's project;
   - verify setup succeeds, the persisted canonical identity matches, and the sidebar shows no ghost
     project after the import;
   - verify a clone with a different remote still shows the mismatch error **and** leaves the second
     repo's stored identity and project membership untouched.
4. Repeat step 3 against an SSH host with the connection dropped mid-flow to confirm the bounded
   probe returns `unavailable` instead of hanging the dialog.

## Rollout

No migration or feature flag is required. Records with a missing or settled-`null` identity are also
repaired passively by background enrichment; records with a **stale non-null** identity are repaired
only by this setup flow, because enrichment skips them.

One change is visible on the first launch after the upgrade, with no user action. The store projects
from the **raw** records, which keep `upstream.host`, so the main process already grouped a GHES repo
under `github:<host>/<owner>/<repo>`. Every _read_ went through `hydrateRepo` → `sanitizeRepoUpstream`,
which used to drop the host, so the renderer received a host-less repo and
`normalizeHydratedProjectHostSetupProjection` re-derived `github:<owner>/<repo>`, overrode
`setup.projectId` with it, and renamed the project row in the UI. Preserving the host in that
sanitizer is required — the GitHub fallback (§6) cannot otherwise persist a GHES project identity that
survives a reload — and it also ends that divergence: the renderer's re-key becomes a no-op and those
setups display under the id the store was already using. The visible effect is still a project rename,
so anything recorded against the host-less id while the UI was showing it is stranded in exactly the
way §4 describes for an identity repair.

That stranding is repaired by a load-time migration (`remapHostLessGitHubEnterpriseProjectIds` in
`src/main/github-enterprise-project-id-remap.ts`). For each host-less `github:<owner>/<repo>` id
referenced by persisted state, it moves the reference onto the host-qualified id when the repos
projection yields exactly one such id for that slug, and skips the id when a live `github.com` repo
genuinely owns it or two Enterprise hosts serve the same slug. It runs before
`mergeProjectHostSetupCompatibilityState` (which rebuilds repo-backed rows and would drop the
host-less row outright), is idempotent so it can run on every load, and marks the state dirty so the
result reaches disk. Scope: `worktreeMeta.projectId`/`projectHostSetupId`, persisted `projects[].id`,
and `projectHostSetups[].projectId`/`id`. Out of scope: renderer-side caches and any other
project-id-keyed state this store does not persist.
