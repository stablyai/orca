# Source Control Branch Action State Machine

## Problem statement

The Source Control panel currently derives commit, push, pull, sync, publish, and PR actions from several overlapping state sources. That makes the UI easy to put into contradictory states: one ref can drive the primary button, another ref can drive the operation that runs after click, and a third ref can drive the branch diff or PR base.

The recent `disk-space-manager-cache-cleanup` failure exposed the concrete bug class:

- The worktree was created to diff and review against `origin/main`.
- Orca pushed to `origin/disk-space-manager-cache-cleanup`.
- The local branch's configured Git upstream was `origin/main`.
- `git push` was rejected because `origin/disk-space-manager-cache-cleanup` had remote commits.
- The failure copy said "Pull first", but Pull was disabled because the UI's ahead/behind status came from the configured upstream, `origin/main`, not the publish target that rejected the push.

The deeper issue is not the wording of one toast. It is that the UI mixes three refs:

- Base ref: the compare base for "Committed on Branch", stale-base checks, and PR base.
- Publish target: the remote branch Orca will update when the user publishes or pushes.
- Configured Git upstream: Git's `@{u}` relationship for the checked-out branch.

These refs can be the same in simple local feature branches, but they diverge for PR-created worktrees, fork PRs, stale metadata, manual `git branch --set-upstream-to`, and SSH-backed worktrees. Source Control needs one canonical branch-operation snapshot that names those refs explicitly and derives every action from the same snapshot.

## Goals

- Make Source Control actions predictable by deriving the primary button and dropdown from one branch-operation state machine.
- Treat base ref, publish target, and configured upstream as separate semantic refs.
- Ensure Pull/Sync recovery is available for the same remote branch that rejected Push.
- Preserve the current split-button shape: one adaptive primary action plus a stable dropdown of secondary actions.
- Keep compound actions as compositions of canonical operations, not separate business logic.
- Maintain local, SSH, and runtime-environment parity.
- Produce enough typed state and transition rules that another agent can implement without redesigning the feature.

## Non-goals

- Redesigning the entire Source Control layout.
- Changing Git commit behavior, staging behavior, conflict rendering, or the diff tree.
- Replacing the repo/worktree base-ref picker.
- Changing hosted review provider detection or PR creation APIs beyond consuming the canonical branch-operation state.
- Implementing the redesign in this document change.

## Current-state analysis

The current code is already partially factored, but the factored pieces still consume mixed semantics.

- `src/renderer/src/components/right-sidebar/source-control-primary-action.ts` is a pure resolver for the primary split-button action. It consumes staged counts, PR state, branch compare counts, and `GitUpstreamStatus`.
- `src/renderer/src/components/right-sidebar/source-control-dropdown-items.ts` is a separate pure resolver for dropdown rows. It independently interprets `GitUpstreamStatus`, `branchCommitsAhead`, and hosted-review eligibility.
- `src/renderer/src/components/right-sidebar/SourceControl.tsx` wires those resolvers to UI state. It computes `effectiveBaseRef` from repo/worktree defaults for branch compare, reads `remoteStatus` from `remoteStatusesByWorktree`, passes `activeWorktree?.pushTarget` into push/sync calls, and creates PRs from hosted-review state.
- `src/renderer/src/store/slices/editor.ts` owns remote operations. `pushBranch` accepts `publish`, `pushTarget`, and `forceWithLease`; `pullBranch` uses plain pull; `syncBranch` fetches, reads upstream status, pulls, then pushes to an optional `pushTarget`.
- `src/main/git/upstream.ts` and the relay equivalent compute ahead/behind for `HEAD...@{u}` only.
- `src/main/git/remote.ts` and `src/relay/git-handler-push-target.ts` push to an explicit `GitPushTarget` when present, otherwise to a configured push target, otherwise `origin HEAD`.
- `src/main/git/status.ts` and `src/relay/git-handler-status-ops.ts` include a lightweight upstream status from `git status --porcelain=v2 --branch`, again for the configured upstream.
- Worktree metadata already persists both `baseRef` and `pushTarget` in `src/shared/types.ts`.

This creates three separate decision surfaces:

- Branch compare asks "what changed from base?" using `effectiveBaseRef`.
- Action enablement asks "is local ahead/behind?" using configured upstream.
- Push execution asks "where should commits go?" using `activeWorktree.pushTarget` or push fallback.

When those surfaces disagree, the UI can recommend an operation that is disabled or execute an operation against a different branch than the row described.

## Proposed model

Add a canonical runtime snapshot produced near the Git boundary, then compose renderer-only draft, review, and busy state on top before resolving actions. The split is intentional: Git/runtime code can know the current branch, refs, local file state, and remote relation, but it must not depend on renderer commit drafts, PR dialog state, or UI busy flags.

Project-owned types should live in `.ts` files, not `.d.ts`. The likely home is a new shared module such as `src/shared/source-control-branch-actions.ts`, with renderer-only action presentation helpers staying in `src/renderer/src/components/right-sidebar/`.

```ts
export type BranchOperationSnapshot = {
  worktreeId: string
  current: CurrentBranchState
  refs: BranchOperationRefs
  local: RuntimeLocalChangeState
  baseCompare: BaseCompareRelation
  target: PublishTargetRelation
  upstream: ConfiguredUpstreamRelation
  freshness: BranchOperationFreshness
}

export type SourceControlBranchActionState = BranchOperationSnapshot & {
  draft: CommitDraftActionState
  review: HostedReviewActionState
  busy: BranchOperationBusyState
}

export type BranchOperationRefs = {
  baseRef: BranchRef | null
  publishTarget: PublishTargetRef | null
  configuredUpstream: BranchRef | null
  effectiveUpstream: EffectiveUpstreamRef | null
}
```

`BranchOperationSnapshot` is the payload returned by `getRuntimeGitBranchOperationState`. `SourceControlBranchActionState` is assembled in the renderer/store and is the only shape passed to action resolvers.

### Current branch state

`current` describes the checked-out local branch:

- `kind: 'branch' | 'detached' | 'unknown'`
- `branchName?: string`
- `headOid?: string`
- `canCommit: boolean`
- `canPublish: boolean`

Detached HEAD is a first-class state. Commit may still be possible, but Publish, Push, Pull, Sync, and Create PR are disabled with "Check out a branch first."

Every enabled mutating remote action requires `current.kind === 'branch'`, `branchName`, and `headOid`. The action resolver should omit `operation` from disabled rows and should only construct `expectedCurrent` from a concrete branch name plus OID.

### Local change state

`local` describes the worktree and index:

- `stagedCount`
- `unstagedCount`
- `untrackedCount`
- `hasPartiallyStagedChanges`
- `hasUnresolvedConflicts`

`draft` is renderer-only state:

- `hasCommitMessage`

This preserves the existing local priority ladder:

1. Conflicts block commit and remote operations that would mutate history.
2. Partially staged files make `Stage All` the safest primary action.
3. Staged files plus a renderer commit message enable `Commit`.
4. Staged files without a renderer commit message disable `Commit` with message guidance.
5. Unstaged/untracked-only changes enable `Stage All`.
6. Clean tree falls through to remote and PR actions.

### Ref semantics

#### Base ref

The base ref answers: "What should this branch be compared against?"

Sources, in priority order:

1. `worktree.baseRef`
2. `repo.worktreeBaseRef`
3. repo default base from `repos:getBaseRefDefault`

Base ref is used for:

- Branch diff and branch change counts.
- PR base default.
- "No branch changes to publish" gating, when the publish target does not exist.
- Stale-base warnings.

Base ref must not be used for Push, Pull, Sync, or publish target ahead/behind.

Represent base comparison separately from publish state:

```ts
export type BaseCompareRelation =
  | { kind: 'loading'; baseRef: BranchRef | null }
  | {
      kind: 'ready'
      baseRef: BranchRef
      commitsAhead: number
      changedFiles: number
      baseOid: string
      headOid: string
      mergeBase: string
    }
  | {
      kind: 'unavailable'
      baseRef: BranchRef | null
      reason: 'no-base-ref' | 'invalid-base' | 'unborn-head' | 'no-merge-base'
      message: string
    }
  | { kind: 'error'; baseRef: BranchRef | null; message: string }
```

Base compare failures must not collapse to `commitsAhead=0`. `Nothing to publish` is only valid when `baseCompare.kind === 'ready' && commitsAhead === 0`; invalid or loading base state should keep Publish disabled with retry/change-base guidance.

#### Publish target

The publish target answers: "Which remote branch will Orca update?"

Sources, in priority order:

1. `worktree.pushTarget`, usually from PR-created worktrees and fork PR setup.
2. A configured upstream only when the deterministic table below says it is the intended publish target.
3. `origin/<currentBranchName>` as the first-publish default.

Resolution table:

| Condition | Publish target | Why |
| --- | --- | --- |
| `worktree.pushTarget` exists and the remote exists | `worktree.pushTarget` | Persisted worktree metadata is Orca's explicit intent, especially for PR-created and fork worktrees. |
| `worktree.pushTarget` exists but remote is missing | `unavailable` with `invalid-target` or `no-remote` | Falling back would silently publish to a different remote than the worktree was created for. |
| Configured upstream remote is `.` or not a remote branch | Skip upstream and use first-publish default | Local-only upstreams cannot be pushed/pulled as remote branches. |
| Configured upstream equals the effective base ref and its branch name differs from the current branch | Skip upstream and use first-publish default | This is the accidental-base bug class: a feature branch tracking `origin/main` should not publish to `origin/main`. |
| Configured upstream is a remote branch whose branch name equals the current branch | Use configured upstream | This preserves normal `origin/feature`, fork remote, and non-origin workflows. |
| Configured upstream is a non-origin remote branch whose branch name differs from current branch | Use configured upstream and surface a mismatch diagnostic | Non-origin tracking can be intentional for fork/review workflows; preserve it rather than guessing `origin/<current>`. |
| Configured upstream is `origin/<differentBranch>` and not the base ref | Use configured upstream only if an explicit existing config already pushes there; otherwise mark `invalid-target` | Pushing a local branch to a differently named origin branch is unusual and high-risk. Require explicit evidence rather than inferring. |
| No usable upstream | `origin/<currentBranchName>` | Current first-publish behavior. |

The "explicit existing config already pushes there" check means `branch.<current>.remote` and `branch.<current>.merge` both name that target, and any configured pushremote/push refspec does not contradict it.

Represent it as:

```ts
export type PublishTargetRef = {
  remoteName: string
  branchName: string
  remoteRef: string // refs/remotes/<remoteName>/<branchName>
  source: 'worktree-push-target' | 'configured-upstream' | 'default-origin-current-branch'
  remoteUrl?: string
  remoteCreated?: boolean
  reviewHead?: HostedReviewHeadRef
}

export type HostedReviewHeadRef =
  | { provider: 'github'; head: string } // e.g. "owner:branch" for fork PRs, "branch" for same-repo PRs
  | { provider: 'gitlab' | 'bitbucket' | 'azure-devops' | 'gitea'; head: string }
```

Publish target is used for:

- Publish Branch.
- Push.
- Pull recovery after publish-target rejection.
- Sync.
- Push before PR.
- PR readiness checks that depend on whether remote head has all local commits.

Publish target must be named in diagnostic copy when that prevents confusion, for example `origin/disk-space-manager-cache-cleanup`.

Hosted review creation must use `reviewHead` when present rather than normalizing `remoteRef` down to a bare branch name. For GitHub fork PRs, the head ref may need to be `owner:branch`; the action state must carry that provider-specific identity so `Push before PR` and `Create PR` validate the same remote branch.

#### Configured Git upstream

The configured upstream answers: "What does Git currently consider `@{u}`?"

This is diagnostic and compatibility state, not automatically the action target. It is still useful because:

- Existing user repos may intentionally track a non-origin branch.
- Git status already exposes it cheaply.
- Mismatch detection lets Orca explain and repair bad states.

Represent it as:

```ts
export type ConfiguredUpstreamRelation =
  | { kind: 'none' }
  | {
      kind: 'present'
      ref: BranchRef
      matchesPublishTarget: boolean
      ahead: number
      behind: number
    }
  | { kind: 'error'; message: string }
```

#### Effective upstream

The effective upstream answers: "Which remote branch should branch actions reconcile with?"

It should be the publish target relation, not blindly `@{u}`:

- If configured upstream matches the publish target, `effectiveUpstream` can use `@{u}` for counts and operations.
- If configured upstream differs from publish target, `effectiveUpstream` is the publish target remote ref.
- If the publish target does not exist, `effectiveUpstream` is absent and the remote state is `unpublished`.

This distinction fixes the bug class. If Push to `origin/feature` is rejected because `origin/feature` has commits, Pull and Sync must reconcile with `origin/feature`, even if `@{u}` is `origin/main`.

## Publish target relation

`target` is the remote relationship that drives action decisions:

```ts
export type PublishTargetRelation =
  | { kind: 'loading' }
  | { kind: 'unavailable'; reason: 'detached' | 'no-remote' | 'invalid-target'; message: string }
  | { kind: 'unpublished'; target: PublishTargetRef }
  | {
      kind: 'published'
      target: PublishTargetRef
      localAhead: number
      remoteAhead: number
      remoteOnlyCommitsArePatchEquivalent?: boolean
      localHeadOid: string
      remoteHeadOid: string
    }
  | { kind: 'error'; target?: PublishTargetRef; message: string }
```

The published relation is computed as `HEAD...<publishTarget.remoteRef>`, not `HEAD...@{u}` unless those refs are the same.

Derived remote states:

| Relation | Derived state | Meaning |
| --- | --- | --- |
| `loading` | `checking` | Action status is not known yet. |
| `unavailable` | `blocked` | No safe remote action can run. |
| `unpublished` plus top-level ready base compare and `commitsAhead > 0` | `needs_publish` | Local branch has work beyond base and target branch does not exist. |
| `unpublished` plus top-level ready base compare and `commitsAhead === 0` | `no_branch_changes` | Nothing useful to publish. |
| `unpublished` plus top-level loading base compare | `checking` | Do not guess publishability yet. |
| `unpublished` plus top-level unavailable/error base compare | `blocked` | Cannot determine whether publishing would create useful remote branch state. |
| `published`, `localAhead=0`, `remoteAhead=0` | `up_to_date` | Remote target and local head match. |
| `published`, `localAhead>0`, `remoteAhead=0` | `needs_push` | Local has commits remote target lacks. |
| `published`, `localAhead=0`, `remoteAhead>0` | `needs_pull` | Remote target has commits local lacks. |
| `published`, both ahead, patch-equivalent remote-only commits | `needs_force_push_with_lease` | Local was rebased; remote has stale copies. |
| `published`, both ahead, not patch-equivalent | `needs_sync` | Local and remote target diverged. |
| `error` | `unknown_error` | Keep old visible state if available; otherwise disable remote actions. |

## Action derivation

Derive all action rows from the same `SourceControlBranchActionState`.

```ts
export type BranchActionKind =
  | 'stage_all'
  | 'commit'
  | 'commit_then_push'
  | 'commit_then_sync'
  | 'publish'
  | 'push'
  | 'force_push_with_lease'
  | 'pull'
  | 'sync'
  | 'fetch'
  | 'create_pr'
  | 'push_then_create_pr'

export type BranchAction = {
  kind: BranchActionKind
  label: string
  title: string
  enabled: boolean
  hidden?: boolean
  reason?: string
  operation?: BranchOperationCommand
}
```

The resolver should have two layers:

1. `resolveBranchActions(state: SourceControlBranchActionState): Record<BranchActionKind, BranchAction>` builds every possible row once.
2. `selectPrimaryBranchAction(actions, state): BranchActionKind` chooses the primary action by priority.

The dropdown should render a stable ordered subset of the same actions. It must not recompute enablement from different inputs.

### Primary action priority

1. Active commit operation: disabled `Commit`.
2. Active remote operation: disabled label matching the active operation.
3. Active PR operation: disabled `Create PR` when the primary would otherwise be PR-related.
4. Conflicts: disabled `Commit`, title `Resolve conflicts before committing`.
5. Partially staged files: `Stage All`.
6. Staged files with renderer draft message: `Commit`.
7. Staged files without renderer draft message: disabled `Commit`, title `Enter a commit message to commit`.
8. Unstaged/untracked-only changes: `Stage All`.
9. Remote state `checking`: disabled stable primary, title `Checking branch status...`.
10. Remote state `needs_publish`: `Publish Branch`.
11. Remote state `needs_force_push_with_lease`: `Force Push`.
12. Remote state `needs_sync`: `Sync`.
13. Remote state `needs_pull`: `Pull`.
14. Remote state `needs_push`: `Push`.
15. PR can create: `Create PR`.
16. Otherwise disabled `Commit`, title explains the clean state.

This keeps the current local-first ergonomics while making remote operations target-consistent.

### Dropdown order

The dropdown remains stable and dense:

1. `Commit`
2. `Commit & Push` or `Commit & Force Push`
3. `Commit & Sync`
4. separator
5. `Push` or `Force Push`
6. `Create PR`
7. `Push before PR` or `Force Push before PR`
8. `Pull`
9. `Sync`
10. `Fetch`
11. `Publish Branch`

Rows can be disabled with a reason. They should only be hidden when the operation is impossible for the repository kind, not merely inapplicable in the current branch state.

### Compound action rules

Compound actions compose canonical operations:

- `Commit & Push` = commit, refresh branch-operation snapshot, then run `push` if the refreshed state is `needs_push`.
- `Commit & Force Push` = commit, refresh, then `force_push_with_lease` only if refreshed state is `needs_force_push_with_lease`.
- `Commit & Sync` = commit, refresh, then `sync` if refreshed state is `needs_pull` or `needs_sync`.
- `Push before PR` = push, refresh branch-operation snapshot and PR eligibility, create PR only if PR eligibility becomes `canCreate`.

Do not pre-bake ahead/behind counts into compound labels because the commit changes those counts.

## Operation semantics

Remote operations must execute against the same publish target used by action derivation.

### Mutating command preflight

Every mutating command must prove it is still acting on the branch snapshot the user saw. The runtime must verify the current branch and `HEAD` immediately before `publish`, `push`, `force_push_with_lease`, `pull`, and `sync`:

```bash
git symbolic-ref --quiet --short HEAD
git rev-parse HEAD
```

If the branch name or `HEAD` differs from the command's expected values, abort before running any remote mutation and refresh `BranchOperationSnapshot`. User copy should say `Branch changed. Refresh Source Control, then try again.` This protects terminal-driven branch changes, agent-driven rebases, and slow SSH/runtime round trips from pushing or merging the wrong `HEAD`.

### Fetch

`Fetch` should fetch all remotes or the publish target remote, depending on existing repo policy, then refresh `BranchOperationSnapshot`.

### Publish Branch

When target is absent:

```bash
git push --set-upstream <remoteName> HEAD:<branchName>
```

Use `worktree.pushTarget` when present. Otherwise use `origin/<currentBranchName>`.

After publish succeeds, persist or refresh so configured upstream matches the publish target. If the operation cannot set upstream, keep `upstream.matchesPublishTarget=false` as diagnostic state but still use the publish target for future actions.

### Push

When target exists and remote is not ahead:

```bash
git push <remoteName> HEAD:<branchName>
```

Use `--set-upstream` when configured upstream is missing or mismatched and it is safe to repair the relationship. This should be explicit in code comments because changing upstream has user-visible Git effects.

### Force Push With Lease

Allowed only when:

- `target.kind === 'published'`
- `localAhead > 0`
- `remoteAhead > 0`
- `remoteOnlyCommitsArePatchEquivalent === true`

Run:

```bash
git push --force-with-lease=refs/heads/<branchName>:<expectedRemoteHeadOid> <remoteName> HEAD:<branchName>
```

`expectedRemoteHeadOid` must be the `remoteHeadOid` from a freshly recomputed `target.kind === 'published'` relation. Do not use plain `--force-with-lease`; a background fetch can advance the local tracking ref after the user saw the state, and a ref-only lease would then allow overwriting commits the user never reviewed. Never offer plain force push.

### Pull

Pull must reconcile with the publish target, not arbitrary `@{u}`.

When `effectiveUpstream` matches configured upstream, existing plain `git pull` behavior is acceptable. When it does not, run a target-specific pull:

```bash
git pull <remoteName> <branchName>
```

This preserves Git's pull strategy configuration (`pull.rebase`, `branch.<name>.rebase`, `pull.ff`, etc.) while targeting the branch named in the UI. A local verification confirmed `git pull origin feature` rebases when `pull.rebase=true`; add an operation test for that behavior. Do not replace this with `git fetch` plus unconditional `git merge`, and do not silently pull from `origin/main` when the UI says the branch needs changes from `origin/<feature>`.

### Sync

Sync is Pull-then-Push against the publish target:

1. Fetch publish target.
2. Recompute target relation.
3. Verify the command's expected branch and `HEAD` still match before mutating.
4. If `needs_force_push_with_lease`, force push with an explicit expected remote OID lease.
5. If `needs_pull` or `needs_sync`, pull from publish target with `git pull <remoteName> <branchName>`.
6. Refresh state.
7. If local is ahead after pull, verify the branch/HEAD expectation again using the refreshed state and push to publish target.

If the push stage fails because the remote moved again, copy should say the remote moved during Sync and offer retry.

## Error and recovery rules

Errors should refresh canonical state before showing stale advice whenever possible.

| Failure | State refresh | User-facing recovery |
| --- | --- | --- |
| Push rejected non-fast-forward | Fetch publish target and recompute relation. | If target is ahead: enable Pull/Sync and say `Push rejected: <target> has new commits. Pull or Sync, then push again.` |
| Publish rejected because target exists remotely | Reclassify as `published` with remote-ahead counts. | Offer Pull/Sync for the publish target; do not leave Publish as the only path. |
| Configured upstream differs from publish target | Mark `upstream.matchesPublishTarget=false`. | Keep actions targeted to publish target. Optional inline detail: `Branch tracks <upstream>, but Orca publishes to <target>.` |
| Pull creates conflicts | Refresh git status and conflict operation. | Show existing conflict UI; primary disabled Commit with conflict title. |
| Pull blocked by local changes | Preserve local-first priority. | Primary should be Stage All or Commit; toast says `Pull blocked: commit or stash local changes first.` |
| Protected branch or auth failure | Preserve target relation if known. | Toast names operation and remote access issue; action remains available if retry could work. |
| Publish target remote is missing | `target.kind='unavailable'`. | Disable remote actions with `Remote <name> is not configured.` |
| Publish target branch deleted after publish | `target.kind='unpublished'` after fetch. | Offer Publish Branch if branch has commits beyond base. |
| Branch is detached | `current.kind='detached'`. | Disable remote/PR actions with `Check out a branch first.` |
| Branch or HEAD changed after the user clicked | Refresh snapshot and leave repository untouched. | Abort with `Branch changed. Refresh Source Control, then try again.` |
| Force-push lease rejected | Fetch publish target and recompute relation. | Keep Force Push disabled unless patch-equivalent relation still holds for the new remote head. |

Recovery copy must never say "Pull first" unless Pull is enabled for the same target branch that caused the failure.

## UX copy principles

Follow `docs/STYLEGUIDE.md`: quiet chrome, one affirmative primary button, dropdown for secondary actions, tooltips for compact control labels, and visible inline state for blocking errors.

- Button labels stay short: `Commit`, `Stage All`, `Publish Branch`, `Push`, `Pull`, `Sync`, `Force Push`, `Create PR`.
- Tooltips and inline errors explain the specific blocker and next step.
- Name the target branch when it disambiguates refs: `origin/main` vs `origin/feature`.
- Avoid internal terms in first-line copy. Prefer `remote branch` over `publish target` in user-visible text.
- Do not use color as the only state signal.
- Keep disabled rows visible in the dropdown so users can discover why an action is unavailable.
- For SSH and runtime environments, bind disabled state immediately and delay visible spinner/label swaps for remote operations as the style guide recommends.

Suggested copy:

- `Checking branch status...`
- `Publish this branch to origin/<branch>.`
- `Pull 2 commits from origin/<branch>.`
- `Sync: pull 2 commits, then push 1 commit.`
- `Push rejected: origin/<branch> has new commits. Pull or Sync, then push again.`
- `Branch tracks origin/main, but Orca publishes to origin/<branch>. Pull and Sync will use origin/<branch>.`
- `Create PR is unavailable until origin/<branch> has your latest commits.`

## Data flow

### New status boundary

Introduce one runtime-aware query:

```ts
getRuntimeGitBranchOperationState(context, {
  baseRef,
  worktreePushTarget,
  linkedReview,
}): Promise<BranchOperationSnapshot>
```

Local implementation lives beside `src/main/git/upstream.ts` and `src/main/git/remote.ts`. Relay implementation mirrors it in `src/relay/`. The renderer calls only the runtime client wrapper.

The query should:

1. Read current branch and HEAD.
2. Resolve base ref from renderer/worktree input.
3. Compute `baseCompare`, preserving loading/unavailable/error rather than coercing failures to zero commits.
4. Resolve publish target with the deterministic table above, including provider-specific `reviewHead` when a hosted review can use it.
5. Resolve configured upstream.
6. Determine whether configured upstream matches publish target.
7. Determine whether publish target remote ref exists.
8. Compute `HEAD...publishTarget.remoteRef` counts when it exists.
9. Compute patch-equivalence for remote-only commits when local and remote both have commits.
10. Return structured errors instead of overloading `hasUpstream=false`.

### Renderer state

Replace action resolver inputs like:

- `upstreamStatus`
- `branchCommitsAhead`
- PR loading booleans scattered through `SourceControl.tsx`

with:

- `branchOperationSnapshot`
- renderer-composed `sourceControlBranchActionState`
- local commit draft fields
- busy flags

`SourceControl.tsx` should become the coordinator that fetches the state and invokes actions. It should not decide whether Pull means upstream or publish target.

### Store state

Keep `remoteStatusesByWorktree` temporarily for other panels such as Checks and workspace cleanup. Add `branchOperationSnapshotByWorktree` for Source Control, then migrate other consumers intentionally.

Remote operation methods should accept a resolved command:

```ts
export type ExpectedCurrentBranch = {
  branchName: string
  headOid: string
}

export type BranchOperationCommand =
  | { kind: 'publish'; target: PublishTargetRef; expectedCurrent: ExpectedCurrentBranch }
  | {
      kind: 'push'
      target: PublishTargetRef
      setUpstream: boolean
      expectedCurrent: ExpectedCurrentBranch
    }
  | {
      kind: 'force_push_with_lease'
      target: PublishTargetRef
      expectedCurrent: ExpectedCurrentBranch
      expectedRemoteHeadOid: string
    }
  | {
      kind: 'pull'
      target: PublishTargetRef
      useConfiguredUpstream: boolean
      expectedCurrent: ExpectedCurrentBranch
    }
  | {
      kind: 'sync'
      target: PublishTargetRef
      useConfiguredUpstream: boolean
      expectedCurrent: ExpectedCurrentBranch
      expectedRemoteHeadOid?: string
    }
  | { kind: 'fetch'; remoteName?: string }
```

This avoids reconstructing the target at click time from stale worktree metadata. The runtime still revalidates `expectedCurrent` immediately before each mutating step because the renderer snapshot can become stale while a command is queued or while SSH/runtime calls are in flight.

## Migration plan

1. Add shared types and pure resolver tests.
   - Add `BranchOperationSnapshot`, `SourceControlBranchActionState`, ref types, and action resolver tests.
   - Keep current UI behavior wired to old inputs.

2. Add local and relay branch-operation status queries.
   - Implement publish-target relation computation locally and in relay.
   - Add parity tests for local and relay command construction.
   - Do not change UI actions yet.

3. Wire Source Control to read canonical state.
   - Store `branchOperationSnapshotByWorktree`.
   - Continue deriving existing button labels from compatibility adapters.
   - Add logging when configured upstream and publish target differ.

4. Switch primary/dropdown resolvers to canonical state.
   - Delete independent `upstreamStatus` and `branchCommitsAhead` action inputs.
   - Make dropdown rows consume `resolveBranchActions` output.

5. Switch remote operations to explicit commands.
   - Push, Pull, Sync, Publish, and Push before PR receive `BranchOperationCommand`.
   - Pull/Sync target the publish target when upstream is mismatched.

6. Clean up legacy state.
   - Remove Source Control dependency on `remoteStatusesByWorktree`.
   - Keep or migrate other consumers separately.

7. Add optional upstream repair.
   - After successful publish/push to a publish target, set upstream to that target when doing so is safe.
   - Surface this behavior in comments and tests because it changes Git config.

## Test plan

### Pure resolver tests

- Clean unpublished branch with commits beyond base -> primary `Publish Branch`; Push/Pull/Sync disabled with publish-first reasons.
- Unpublished branch with no commits beyond base -> primary disabled `Commit`; Publish disabled `Nothing to publish`.
- Unpublished branch with invalid/loading base compare -> no `Nothing to publish`; Publish is disabled with retry/change-base guidance.
- Published target local ahead -> primary `Push`; dropdown Push enabled.
- Published target remote ahead -> primary `Pull`; Push disabled with pull/sync reason.
- Published target diverged -> primary `Sync`; Pull, Sync enabled; Push disabled unless patch-equivalent.
- Patch-equivalent diverged state -> primary `Force Push`; Sync disabled with force-push reason.
- Staged changes with message always prefer `Commit` over remote actions.
- Partially staged files prefer `Stage All`.
- Conflicts disable commit and remote mutations.
- PR can create only appears after target is up to date.
- `Push before PR` enabled only when PR is blocked by local commits and target can push.

### Git state tests

- Worktree with `baseRef=origin/main`, `pushTarget=origin/feature`, and configured upstream `origin/main`; remote `origin/feature` ahead. Expected: target relation `needs_pull`, upstream mismatch diagnostic, Pull enabled for `origin/feature`.
- Same setup with remote `origin/feature` diverged. Expected: Sync enabled, Push disabled.
- Same setup with no `origin/feature`. Expected: Publish Branch enabled if branch has commits beyond `origin/main`.
- Configured upstream matches publish target. Expected: effective upstream uses configured upstream.
- No configured upstream and no explicit push target. Expected: default publish target `origin/<currentBranch>`.
- Fork PR worktree with explicit push target remote. Expected: actions use fork remote branch, not base repo default branch.
- Fork PR worktree with explicit push target remote. Expected: `reviewHead` carries provider-specific head identity, such as GitHub `owner:branch`.
- Configured upstream `origin/main` with current branch `feature` and base `origin/main`. Expected: publish target is `origin/feature`, not `origin/main`.
- Non-origin configured upstream with a different branch name and no explicit push target. Expected: publish target preserves that upstream and surfaces a diagnostic.
- Remote target deleted after previous publish. Expected: state transitions back to `unpublished`.
- Detached HEAD. Expected: no publish target and remote/PR actions disabled.

### Operation tests

- Push command uses `HEAD:<publishTarget.branchName>` for explicit targets.
- Publish uses `--set-upstream`.
- Pull with matching upstream uses configured pull path.
- Pull with mismatched upstream runs `git pull <remoteName> <branchName>`, not `@{u}`.
- Targeted pull preserves Git pull strategy config, including `pull.rebase=true` and `pull.ff=only`.
- Sync uses target fetch, target pull, target push.
- Non-fast-forward push rejection refreshes target state before setting inline error.
- Mutating commands abort without touching the remote when branch name or `HEAD` differs from `expectedCurrent`.
- Force push uses explicit `--force-with-lease=refs/heads/<branch>:<expectedRemoteHeadOid>` and is unavailable otherwise.
- `Push before PR` pushes, refreshes state, then creates the PR only if eligibility becomes `canCreate` and the provider head identity still matches the publish target.

### UI tests

- Primary and dropdown rows agree because both read the same action map.
- Disabled dropdown rows show actionable titles.
- In-flight remote operation keeps the user-triggered label.
- Error copy names the target branch when upstream and publish target differ.
- SSH/runtime worktree keeps disabled state immediate and loading state stable during slow status checks.

### Cross-platform and SSH tests

- All path handling uses existing path utilities; no hardcoded separators.
- Relay and local branch-operation state snapshots match for the same fixture repo.
- SSH provider routes the new query and command payloads through runtime RPC.
- Windows Git output with CRLF parses publish target and upstream refs correctly.

## Risks and follow-up decisions

- Upstream repair: setting upstream to publish target fixes future Git behavior but mutates user config. The implementation should do it after publish and possibly after push, with tests and a short comment.
- Fetch cost: computing publish-target relation may require fetches. Polling should not fetch every three seconds; use cached remote refs for background status and explicit fetch before remote mutations.
- Branch names that differ only by case can behave differently on case-insensitive filesystems. Target validation should stay in shared Git validation code.
- Multiple remotes with the same URL may make target explanations verbose. The state should keep remote name and URL, but UI copy should start with remote name.
- PR eligibility currently depends on upstream ahead/behind. It must move to publish-target relation and consume `reviewHead` so provider APIs do not assume a bare GitHub branch name.
- Workspace cleanup and Checks still use upstream status. They may need a separate follow-up to avoid reporting unpushed commits against the wrong ref.
- Existing tests assert current labels and tooltips. Migration should preserve labels where semantics stay the same and update only the cases where target-aware behavior differs.
