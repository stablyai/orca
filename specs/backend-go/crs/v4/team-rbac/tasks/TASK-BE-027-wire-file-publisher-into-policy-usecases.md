# TASK-BE-027: Wire `FilePublisher` into `create`/`update`/`delete_access_policy.go` + `main.go`

> **Status: ✅ DONE — 2026-09-09**

**Solution:** BE-SOL-006 | **CR:** CR-RBAC-006
**Depends on:** TASK-BE-025 (`FilePublisher`/`ValidateBundleAt` must exist).

---

## Goal

Only `update_access_policy.go` currently calls the publisher port at all —
`create_access_policy.go`/`delete_access_policy.go` don't call it today. **Verify at implementation time**
whether that's intentional (e.g. "a version-1 create has no prior enforcement to change") or an oversight
— BE-SOL-006 flags it as unresolved either way, don't assume.

## What to do

1. Read `create_access_policy.go`, `update_access_policy.go`, `delete_access_policy.go` to confirm current
   publisher-call behavior for each.
2. Decide (and document the decision in the commit/PR description, with reasoning) whether `create`/
   `delete` should also call `PolicyDataPublisher.PublishPolicyChange` — the solution's own read is that
   they likely should (a newly created or deleted policy is exactly the kind of change that needs to take
   effect), but this needs confirming against the domain's actual semantics (e.g. does a policy exist in
   an "inactive draft" state before first publish?).
3. Ensure all 3 usecases that should publish do so, calling the new `FilePublisher` (not `NoopPublisher`).
4. `backend-go/services/auth-service/cmd/server/main.go`: replace `authpolicypublisher.New(logger)`
   (the `NoopPublisher` constructor) with `FilePublisher`'s constructor, pointed at the same
   `OPA_BUNDLE_PATH` config value `Evaluator` already reads.
5. Add a config toggle or startup log line callable to force `NoopPublisher` in a specific deployment if
   needed for a safe rollback — consistent with TASK-BE-024's `checkPeriod: 0` rollback lever.

## Acceptance Criteria

- [x] `create_access_policy.go`/`update_access_policy.go`/`delete_access_policy.go`'s publisher-call
      behavior is confirmed and, where the decision is "should publish," implemented consistently across
      all 3.
- [x] `main.go` wires `FilePublisher` in place of `NoopPublisher`.
- [x] Integration test (per the CR's own acceptance criterion): `UpdateAccessPolicy` → wait ≤
      `checkPeriod` (or force-invalidate in test) → a real `Decision` call against the same `Evaluator`
      instance reflects the new policy, with **no process restart** in the test.
- [x] Deploy-config note added (comment or doc, not code): the bundle path must be a shared,
      writable-by-auth-service, readable-by-others volume across all 4 consuming services' pods — flag
      this as an operational requirement for the deploy/infra owner, not something this task can verify in
      code.
- [x] `go build ./...` / `go test ./...` clean for `auth-service`.

## gitnexus

Reuses `NoopPublisher`'s impact numbers (LOW risk, 3 impacted) — `PolicyDataPublisher`'s interface is
unchanged, only the concrete implementation wired in `main.go` changes. Run
`detect_changes({scope:"compare", base_ref:"main"})` after, and specifically confirm no other service's
`Evaluator`-backed authorization decisions regress — this is the task that finally makes a previously
inert `NoopPublisher` write to a path 4 services actually read, so it deserves the most careful
post-change verification in this whole solution.

## Kết quả thực tế

### Decision: create and delete should both publish

Confirmed against `specs/backend-go/tdd/services/auth-service.md`'s `AccessPolicy` invariant ("every
update is a new version, not an in-place mutation — OPA bundle sync **and audit** both need a stable
history of what did the policy input look like at time T") — there is no "inactive draft" state anywhere
in the domain docs. Decision:

- **Create should publish.** A version-1 policy is exactly the kind of change that needs to take effect —
  an admin creating an access policy expects it enforced immediately, not silently inert until the first
  subsequent Update call (which would be a confusing, undocumented gap for any admin-console user).
- **Delete should also publish** — but as a genuine correctness/security concern, not an obvious "just
  call PublishPolicyChange again": `PolicyDataPublisher` has only one method
  (`PublishPolicyChange(ctx, policy)`, which WRITES `policy.DocumentJSON` to the bundle path), no
  dedicated "unpublish"/"retract." Skipping delete's publish entirely would mean a deleted policy's last
  published content stays live in the OPA bundle **forever** — a real enforcement bug (deleting an
  `admin_override`/`extra_admins`-kind policy would never actually revoke the override). Implemented
  retraction as publishing an **emptied document** (`"{}"`) at the same `kind`/`name` bundle path: any
  `data.<kind>...` rule that depended on this policy's content now sees an empty object, the same "no
  policy" state a rule sees before the policy ever existed — without needing a new port method. Kept
  backward-compatible: `DeleteAccessPolicy` on a nonexistent id stays the same idempotent no-op it was
  before (fetches `GetLatestPolicy` first; skips the delete-then-retract-publish path entirely, no error,
  no publish call, if the id doesn't exist — `TestDeleteAccessPolicy_NonexistentID_IsIdempotentNoPublish`
  covers this explicitly).

### Changes

1. `backend-go/services/auth-service/internal/usecase/create_access_policy.go`: added
   `publisher PolicyDataPublisher` field + constructor param; calls
   `uc.publisher.PublishPolicyChange(ctx, policy)` after `InsertPolicyVersion` succeeds, same
   `AUTH_POLICY_PUBLISH_FAILED` non-blocking-on-DB-write error shape `update_access_policy.go` already
   uses.
2. `backend-go/services/auth-service/internal/usecase/delete_access_policy.go`: added
   `publisher PolicyDataPublisher` + `clock Clock` fields/params. `Execute` now: captures `actor` from
   `requireAdminActor` (previously discarded), fetches `GetLatestPolicy(id)` BEFORE deleting (for
   `kind`/`name` — a miss means nothing to retract, not an error), calls `DeletePolicy` (unchanged,
   idempotent), and — only if the policy existed — builds a tombstone `domain.AccessPolicy{DocumentJSON:
   "{}", Version: current.Version+1}` and publishes it.
3. `backend-go/services/auth-service/internal/config/config.go`: added `DisablePolicyPublish bool`
   (`OPA_POLICY_PUBLISH_DISABLED` env var, default `false`) + a new `boolEnv` helper (silent fallback to
   default on an unparseable value, matching this field's own low-stakes rollback-lever nature) — the
   config toggle this task's step 5 asked for, mirroring TASK-BE-024's `checkPeriod:0` rollback lever.
4. `backend-go/services/auth-service/cmd/server/main.go`: `policyPublisher` now branches on
   `cfg.DisablePolicyPublish` — `true` logs a startup `WarnContext` and falls back to
   `authpolicypublisher.New(logger)` (`NoopPublisher`); otherwise (default) wires
   `authpolicypublisher.NewFilePublisher(cfg.OPABundlePath, opaEvaluator)`, reusing the SAME `opaEvaluator`
   instance every `requireAdminActor` call already shares — required for `ValidateBundleAt`'s pre-write
   compile check and for `FilePublisher`'s writes to be visible to that same process's own `Decision`
   calls (no restart). `createAccessPolicyUC`/`deleteAccessPolicyUC`'s constructor calls updated for the
   new `publisher`/`clock` params.
5. Test call-site updates for the 2 new constructor params: `access_policy_versioning_test.go` (3
   `NewCreateAccessPolicy` sites, 1 `NewDeleteAccessPolicy` site — each now passes a `publisher :=
   &fakePolicyPublisher{}` already declared in scope) and `get_admin_stats_test.go` (1 site). Also fixed
   `TestUpdateAccessPolicy_CalledTwice_PersistsTwoVersions`'s stale assertion (`publisher.published` count
   2 → 3, since create now publishes too).
6. New test coverage in `access_policy_versioning_test.go`:
   `TestDeleteAccessPolicy_RemovesAllVersions` extended to assert 2 `PublishPolicyChange` calls
   (create + delete-retraction) and that the retraction's `DocumentJSON == "{}"` at the deleted policy's
   own `kind`/`id`; new `TestDeleteAccessPolicy_NonexistentID_IsIdempotentNoPublish`.
7. New `backend-go/services/auth-service/internal/usecase/access_policy_publish_integration_test.go` —
   the CR's own required integration test. Lives in `package usecase` (internal test package, not
   `usecase_test`) specifically so it can import the adapter package `policypublisher` in a `_test.go`
   file without `usecase`'s production code ever depending on it (a `_test.go` file is never compiled into
   the production binary, so this doesn't violate the ports-based dependency rule). Uses a REAL
   `policy.Evaluator` (fast `checkPeriod: 20ms`, not the 2s default) and a REAL `policypublisher.FilePublisher`
   pointed at a `t.TempDir()`, driving `CreateAccessPolicy` then `UpdateAccessPolicy` against fakes for
   everything else, and asserts `Decision` against that SAME `Evaluator` instance: undefined/deny before
   any publish → still-stale deny/allow immediately after each publish (inside `checkPeriod`) → correctly
   reflects the new value once `checkPeriod` elapses — all without any process restart, matching the CR's
   exact acceptance wording.

   **Finding surfaced while building this test (not fixed — out of this task's scope):** empirically
   confirmed (via a throwaway scratch test against `common/policy`, removed before finishing) that
   `rego.Load` (what `common/policy.Evaluator` actually uses — a plain file loader, NOT OPA bundle-mode,
   so `.manifest`'s `"roots": ["orca/authz"]` is never consulted) merges a JSON data file's top-level keys
   directly at the path of its **enclosing directory only** — the file's own basename contributes **no**
   path segment. Concretely: `FilePublisher` writes to `<bundlePath>/data/<kind>/<name>.json`, but that
   resolves at query time to `data.data.<kind>` (merged straight from the directory path, doubling "data"
   because `bundlePath` itself contains a literal `data/` subdirectory) — **not**
   `data.<kind>.<name>` and not `data.orca.authz.<kind>.<name>` as `admin.rego`'s TASK-BE-026 comment
   assumes (`"published by PolicyDataPublisher to data/admin_override/extra_admins.json"` consumed as
   `data.orca.authz.admin_override.extra_admins.user_ids`). Two consequences for that earlier work,
   neither touched here: (a) the `orca.authz` root never appears without genuine OPA bundle-mode loading,
   and (b) the filename (`name`) segment is dropped entirely by this loader's own merge convention, so two
   different-`name` policies sharing the same `kind` would silently collide/merge at the same
   `data.data.<kind>` path instead of landing at distinct locations. This task's own integration test
   works around it correctly (its rego rule queries `data.data.testkind.allowed_value`, empirically
   verified, with only one policy under that `kind`) — flagging this for whoever revisits TASK-BE-026's
   `admin.rego` clause or extends `FilePublisher`'s path scheme, since `opa test` (bundle-mode, manifest-
   aware) would not have caught this the way a real `Evaluator.Decision` call does.

### Deploy-config note (operational, not code)

`OPA_BUNDLE_PATH` (env `OPA_BUNDLE_PATH`, default `/policy/orca-authz`) must be a **shared,
writable-by-auth-service, readable-by-others** volume mounted into all 4 consuming services' pods
(auth-service itself, task-service, annotation-service, infra-fleet-service) — e.g. a shared PVC or a
sidecar sync. Before this task, every service's `OPA_BUNDLE_PATH` config already assumed a shared path
existed but nothing ever wrote to it from auth-service; this task makes that a real, load-bearing
operational requirement for the first time. Flagging for the deploy/infra owner — not verifiable from
code/tests in this repo.

### gitnexus

`impact({target:"CreateAccessPolicy", kind:"Struct"})` / `impact({target:"DeleteAccessPolicy",
kind:"Struct"})`: **LOW risk, 3 impacted** each (matches this task file's pre-existing note, re-confirmed
this pass — 1 direct caller each, the gRPC handler + generated client/server interface methods).
`impact({target:"NoopPublisher"})`: **LOW risk, 3 impacted**, 1 process (`run` in `main.go`) — confirms
`PolicyDataPublisher`'s interface itself is unchanged, only `main.go`'s concrete wiring changed, exactly as
the task file predicted. `impact({target:"Load", file_path:".../internal/config/config.go"})` for the new
`DisablePolicyPublish` config field: **LOW risk, 2 impacted**, 1 process (`run` in `main.go`) — purely
additive.

### Results

- `go build ./...` (auth-service module): clean.
- `go test ./...` (auth-service module): **PASS**, including the new integration test and the 2 new/updated
  `delete_access_policy` unit tests.
- `gofmt -l` on every changed `.go` file: no output (clean).

### Note on concurrent editing of `cmd/server/main.go`

A second, unrelated in-flight session (CR-CLI-002/TASK-BE-CLI-004/005/006, adding
`IsServiceTokenRevoked`/`ListCliTokens`/`RevokeCliToken`) was actively editing this exact file
concurrently. It had already threaded a temporary, minimal fix through `createAccessPolicyUC`/
`deleteAccessPolicyUC`'s call sites (just to keep its own `go build` passing once this task's usecase
signature changes landed), left with an explicit comment marking it as out-of-scope/temporary. This task's
edit replaced that temporary fix with the real, permanent `FilePublisher`/`NoopPublisher`-toggle wiring
described above, at the same call sites — verified afterward that the other session's own
`IssueServiceToken`/`RevokeCliToken`/etc. wiring (which changed again, independently, after this edit) was
left completely untouched and the whole file still builds clean.

## Blocking

Blocked on TASK-BE-025.
