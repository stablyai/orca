# Remote Repo And Project Identity Notes

## Current Evidence

As of this branch review, we have not proven a current clean user/API flow that creates the same `Repo.id` on two different hosts.

Fresh repo creation paths mint new UUID-backed repo ids:

- Local add/import/clone creates `Repo.id` with `randomUUID()`.
- SSH add/import/clone also creates `Repo.id` with `randomUUID()`.
- Remote Orca Server runtime RPC methods for `repo.add`, `repo.create`, and `repo.clone` do not accept caller-supplied repo ids; the runtime creates the repo id.
- `projectHostSetup.setupExistingFolder` routes through the same repo creation paths.
- `projectHostSetup.create` can create an independent setup id, but it does not create a `Repo` row and keeps `repoId: ''`.

Therefore, a normal flow like "add the same GitHub repo on local and on a remote server" should produce different repo ids.

## What The Existing Fix Stack Assumes

PRs #6030 and #6031 target the state shape where multiple hosts expose repo rows with the same `Repo.id`, for example:

```ts
[
  { id: 'same-repo', path: '/Users/alice/orca', executionHostId: 'local' },
  { id: 'same-repo', path: '/srv/orca', executionHostId: 'runtime:env-1' }
]
```

The current code can represent that shape, and some renderer paths already key repo rows by `(hostId, repoId)`. But the creation path for that shape is not established by the current add/import/clone code. Plausible sources are copied, restored, synced, seeded, or older persisted Remote Orca Server state, but those are not the same as a proven current product flow.

The precise rationale should be:

> Remote Orca Server state is an external persisted authority. If duplicate repo ids are allowed or observed across hosts, physical repo and worktree state must be keyed by host as well as repo id. Without that, bare-`repoId` logic can mutate, remove, or merge the wrong host's state.

It should not be stated as:

> Normal independent multi-host repo setup definitely creates duplicate repo ids.

We have not proven that.

## Repo And Project Model On Main

`Repo`, `Project`, and `ProjectHostSetup` are already distinct concepts on `main`, but the model is transitional.

- `Repo` is the concrete repo record/setup.
- `Project` is the logical project and has `sourceRepoIds`.
- `ProjectHostSetup` links a project to a host and, when repo-backed, to a `repoId`.

The compatibility projection derives projects and setups from repos:

```text
GitHub identity present:
  projectId = github:<owner>/<repo>

No recognized provider identity:
  projectId = repo:<repoId>
```

That means GitHub-backed repos can be many-to-one:

```text
repoId A -> projectId github:stablyai/orca
repoId B -> projectId github:stablyai/orca
```

Fallback repos remain effectively one-to-one:

```text
repoId A -> projectId repo:<repoId A>
```

## What #6030 Was Addressing

#6030 made repo-row operations host-aware for the duplicate-`Repo.id` state shape:

- repo refresh should not replace same-id repos from sibling hosts;
- repo update should target the active/requested host row;
- repo removal should remove only the intended host row;
- repo reorder should preserve host-specific rows;
- runtime-owner lookup should choose the host-specific row.

This is about repo rows.

## What #6031 Was Addressing

#6031 extended the same idea to project-host setup and worktree state:

- project compatibility should not erase another host's project membership;
- `projectHostSetups` should not collapse by bare repo id;
- worktree identity should include host context, because legacy worktree ids are `repoId::path`.

This matters if two hosts can expose the same repo id and same path, because both would otherwise produce the same legacy worktree id:

```text
same-repo::/workspace/orca
```

The host-qualified worktree key avoids that by including:

```text
hostId + repoId + path
```

## Open Decision

Before treating the richer host-qualified worktree id migration as mandatory, we should decide which product invariant we want:

1. `Repo.id` is globally unique across every connected host/runtime.
   - Then duplicate-id handling is defensive hardening.
   - The larger worktree id migration may be more than the proven current risk requires.

2. `Repo.id` is only unique inside one host/runtime store.
   - Then `(hostId, repoId)` is the correct physical repo identity.
   - Host-qualified worktree ids are the correct physical worktree identity.

The current code mostly mints UUID repo ids, but it also contains host-aware duplicate-id handling. The product contract should be made explicit.
