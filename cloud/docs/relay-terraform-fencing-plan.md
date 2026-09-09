# Relay Terraform Fencing Recovery Plan

Status: private broker implementation in review; no production mutation performed

## Current status

- `2d7dc31` commits Terraform-owned per-cell zero/one desired size and removes
  the lifecycle ignore.
- The follow-up slice implements private exact saved plans, SHA-256 binding,
  durable attempt evidence, lost-response inspection, resume, proven
  pre-apply abort, and exact-incarnation attestation.
- Focused Terraform-fence, multi-target, relay database, assignment-store, and
  black-box tests pass locally.
- Production remains untouched. A rollout still requires review, CI, the
  director/schema deployment, an initial output-state refresh, and a separate
  reviewed fence-set commit for any cell selected during an incident.
- The private Cloud Run broker owns the exact Terraform checkout, saved plans,
  state access, Compute mutation, and a durable GCS mutation lease. The
  workflow requester can invoke the broker and read aggregate evidence but
  cannot mutate Terraform state, Compute, or director fence routes.

## Goal

Make production relay-cell fencing a Terraform-managed, resumable operation.
The workflow must never attest a cell as fenced until Terraform state, GCE,
runtime identity, and retained routing all prove the same exact cell
incarnation is offline.

## Safety boundary

- Do not deploy, mutate GCP, push, or create a pull request during implementation.
- Keep the cell route and backend while its MIG is fenced at size zero.
- Treat any Terraform apply whose start cannot be disproved as recover-forward.
- Never restore a fenced cell automatically after an apply may have started.
- Store plans in a private temporary directory and remove them on every exit.
- Never print, upload, or commit complete plan JSON.
- Fence modes are fail-closed until a private mutation broker owns the narrow
  state/plan and exact-cell Compute permissions. The exact-workflow GHA fence
  account must never receive those permissions or director mutation routes
  directly; it has only aggregate reads and fence-attempt status.
- The monitor identity has no Terraform state access. It can call only the
  aggregate selector, cell, evacuation, and runtime status routes.
- The broker accepts only its configured source, failed target, and
  replacement target. Its image commit must equal the reviewed fence commit;
  callers cannot override topology, Terraform paths, commands, or identities.

## State model

1. Add `relay_gce_fenced_cells` as the committed set of cell IDs whose desired
   MIG size is zero.
2. Derive every cell's desired size from that set: fenced is zero, otherwise
   one.
3. Reject unknown fenced IDs and any topology outside the zero-or-one
   invariant.
4. Remove the MIG `target_size` lifecycle ignore so Terraform owns the fence.
5. Persist one durable attempt record keyed by an unguessable attempt ID. It
   binds environment, cell ID, exact cell incarnation, MIG/generation
   identity, fence commit, saved-plan digest, GCE operation, creation time,
   expiry, and terminal status.

## Operation sequence

### 1. Prepare and guard

1. Require the explicit fence confirmation and a clean checkout at the exact
   fence commit.
2. Confirm the committed production fence set contains the requested cell.
3. Read Terraform state and live topology, then bind the attempt to the exact
   MIG, instance group, backend, origin, and cell incarnation.
4. Run the existing admission, assignment, lease, migration, connection,
   heartbeat, backend, and route guards before planning.

### 2. Create and validate the exact plan

1. Create a private temporary directory with mode `0700` under `umask 077`.
2. Write the saved plan there and compute its SHA-256 digest.
3. Inspect only narrow fields from `terraform show -json`.
4. Require exactly one relevant in-place MIG update from target size one to
   zero.
5. Reject create, delete, replace, unrelated update, route/backend removal, or
   any different cell action.
6. Persist the pending attempt evidence before apply.

### 3. Apply or recover forward

1. Recheck the pre-apply guards and saved-plan digest immediately before apply.
2. Apply the exact saved plan with Terraform locking.
3. If apply fails or its response is lost, inspect Terraform state, live MIG
   size, remaining instances, and the relevant GCE operation.
4. If apply may have started, retain the committed fence set and keep polling
   forward until the MIG converges to zero or a bounded, diagnosable failure is
   recorded.
5. Resume idempotently from durable evidence after workflow or runner loss.

### 4. Abort before apply

1. Allow abort cleanup only when evidence proves apply never began.
2. Require Terraform state and live MIG to remain at one with the original
   identity and topology.
3. Mark the attempt aborted, remove the cell from the committed fence set
   through a separately reviewed commit, and delete local plan artifacts.
4. If apply start is ambiguous, refuse abort and recover forward.

### 5. Attest

1. Require Terraform state target size zero.
2. Require live MIG target size zero and no managed instances.
3. Require the exact MIG/generation identity and retained route/backend
   topology to match the attempt.
4. Require admission disabled and the exact runtime heartbeat stale.
5. Require unexpired durable attempt evidence and the same saved-plan digest,
   fence commit, and GCE operation.
6. Record the exact-incarnation cell fence and complete the attempt in one
   database transaction.

## Implementation slices

- Terraform: variable, per-cell desired size, validation, outputs, tfvars, IAM.
- Relay contract: durable attempt schema, store methods, admin endpoints, exact
  attestation binding, retention/expiry.
- Deployment tooling: private plan lifecycle, digest and selector validation,
  apply/recovery/abort state machine, GCE operation inspection.
- Workflow: explicit prepare/apply/resume/abort modes and no direct MIG resize.
- Runbooks: committed fence-set, exact-plan, recover-forward, and reviewed
  abort procedures.

## Required tests

- Normal fence plan and apply.
- Lost or ambiguous apply response recovers forward.
- Resume when Terraform state and live MIG are already zero.
- Pre-apply guard failure performs no mutation.
- Proven pre-apply abort permits committed fence-set cleanup.
- Ambiguous apply refuses abort cleanup.
- No attestation before every Terraform, GCE, route/backend, heartbeat, and
  exact-incarnation condition passes.
- Saved-plan validation rejects unrelated, replacement, create, and destroy
  actions.
- Attempt evidence rejects wrong environment, cell, incarnation, MIG,
  generation, commit, digest, operation, expiry, and terminal state.

## Validation

- Focused Node and relay contract tests.
- `pnpm test`, `pnpm typecheck`, and `pnpm lint`.
- Sequential relay contract and relay builds after schema/API changes.
- Terraform 1.15.8 `fmt -check -recursive`, `init -backend=false`, and
  `validate`.
- `git diff --check`, local commit, and clean worktree.
