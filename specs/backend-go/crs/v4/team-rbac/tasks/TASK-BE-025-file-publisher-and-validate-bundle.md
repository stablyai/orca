# TASK-BE-025: `FilePublisher` (real `PolicyDataPublisher`) + `Evaluator.ValidateBundleAt`

> **Status: ✅ DONE — 2026-09-09**

**Solution:** BE-SOL-006 | **CR:** CR-RBAC-006
**Depends on:** TASK-BE-024 (self-invalidation must exist for a publish to ever take effect without a
restart) — implement this task after TASK-BE-024, even though the two touch different primary concerns,
so the pipeline is testable end-to-end as soon as this lands.

---

## Goal

Replace `policypublisher.NoopPublisher` (currently only logs a warning) with a real publisher that writes
`AccessPolicy.DocumentJSON` to the shared OPA bundle path, validating first that the resulting bundle still
compiles — so a bad write can never corrupt a bundle every service reads.

## What to do

1. `backend-go/common/policy/evaluator.go`: add a new exported method (not a change to `Decision`/`Warm`'s
   signatures):

```go
// ValidateBundleAt loads a candidate bundle directory (or an in-memory
// overlay) and confirms it still compiles, without affecting this
// Evaluator's own cached state. Used by PolicyDataPublisher to reject a
// write that would break the OPA bundle every service reads.
func (e *Evaluator) ValidateBundleAt(ctx context.Context, candidatePath string) error
```

2. `backend-go/services/auth-service/internal/adapter/policypublisher/publisher.go`: add `FilePublisher`
   alongside the existing `NoopPublisher` (keep `NoopPublisher` in the package for tests that don't care
   about publish behavior):

```go
// PublishPolicyChange writes policy's document_json to
// <bundlePath>/data/<kind>/<name>.json — a plain file OPA's rego.Load
// already knows how to merge as a data document when pointed at a directory
// (rego.Load([]string{bundlePath}, nil) in common/policy.Evaluator already
// loads the whole directory tree, not just *.rego files).
func (p *FilePublisher) PublishPolicyChange(ctx context.Context, policy domain.AccessPolicy) error {
	// 1. Validate document_json is well-formed JSON.
	var doc any
	if err := json.Unmarshal([]byte(policy.DocumentJSON), &doc); err != nil {
		return fmt.Errorf("policypublisher: policy %s document is not valid JSON: %w", policy.ID, err)
	}
	// 2. Validate the WHOLE bundle (existing .rego + this new/changed data
	//    file) still compiles — reject before writing if not.
	path := filepath.Join(p.bundlePath, "data", policy.Kind, policy.Name+".json")
	if err := p.validateCompiles(ctx, path, policy.DocumentJSON); err != nil {
		return fmt.Errorf("policypublisher: policy %s would break the OPA bundle: %w", policy.ID, err)
	}
	// 3. Atomic write: temp file + rename, never a partial write a
	//    concurrently-reloading Evaluator could observe mid-write.
	return atomicWriteFile(path, []byte(policy.DocumentJSON))
}
```

`validateCompiles` should load a **temporary copy** of the bundle directory (or an in-memory overlay) with
the candidate file already written, then call `Evaluator.ValidateBundleAt` against it.

## Acceptance Criteria

- [x] `Evaluator.ValidateBundleAt` loads a candidate bundle path and returns an error if it fails to
      compile, without mutating the receiving `Evaluator`'s own cached state.
- [x] `FilePublisher.PublishPolicyChange` rejects (no file written) invalid JSON.
- [x] `FilePublisher.PublishPolicyChange` rejects (no file written) a candidate that would break bundle
      compilation.
- [x] A successful write is atomic (temp file + rename) — no partial write is ever observable.
- [x] `NoopPublisher` remains in the package, unmodified, for tests that don't need real publish behavior.
- [x] `policypublisher/publisher_test.go` (new): covers the 3 acceptance points above.
- [x] `go build ./...` / `go test ./...` clean for `auth-service` and `common/policy`.

## gitnexus

`impact({target:"NoopPublisher", direction:"upstream", repo:"orca"})`: **LOW risk, 3 impacted** (1 direct —
`New` in the same file; the process hit is `run`/`main` in `auth-service/cmd/server/main.go`), matching
BE-SOL-006's earlier finding. Confirms `PolicyDataPublisher`'s interface (`ports.go:130`) stays unchanged —
this task adds `FilePublisher` as a second, independent implementation alongside `NoopPublisher`, wired into
`main.go` only in TASK-BE-027, so `NoopPublisher`'s own 3-impacted blast radius is untouched by this task.

`impact({target:"Evaluator", direction:"upstream", repo:"orca", summaryOnly:true})`: **HIGH risk, 9
impacted** (1 direct — `New` in `evaluator.go` itself; 3 processes affected — `auth-service`,
`project-service`, `task-service`'s `cmd/server/main.go` `run` functions, each constructing their own
`Evaluator` and calling `Warm`/`Decision` against it). Per this task's own caution (same CRITICAL
shared-primitive risk as TASK-BE-024): `ValidateBundleAt` is a **new, additive method** — it does not touch
`Decision`, `Warm`, `preparedQuery`, `invalidateIfBundleChanged`, or any of `e.mu`/`e.prepared`/
`e.lastChecked`/`e.lastModHash`, so none of the 9 impacted symbols/processes are affected by this change;
every existing `Decision`/`Warm` call site keeps its exact prior behavior. Verified by running the full
`common/policy` test suite (including `TestEvaluator_Warm_Succeeds_ForRealBundle` and the
`invalidateIfBundleChanged`-focused tests) unchanged and green after the addition.

## Kết quả thực tế

1. `backend-go/common/policy/evaluator.go`: added `Evaluator.ValidateBundleAt(ctx, candidatePath) error` —
   a standalone `rego.New(rego.Query("data"), rego.Load([]string{candidatePath}, nil)).PrepareForEval(ctx)`
   call that never reads or writes any receiver field, so it can't perturb the calling `Evaluator`'s own
   cached `prepared` map or force a real service's next `Decision`/`Warm` call to recompile. Querying the
   bare `"data"` document is enough — OPA's compiler validates every loaded module as one unit regardless of
   which specific rule is queried, so a compile error anywhere in the candidate bundle surfaces here.
2. `backend-go/services/auth-service/internal/adapter/policypublisher/publisher.go`: added `FilePublisher`
   (`NewFilePublisher(bundlePath, evaluator)`) implementing `PublishPolicyChange` per the task's sketch:
   validate JSON → `validateCompiles` (copies `bundlePath` into a throwaway temp dir via a new `copyDir`
   helper, writes the candidate file into the copy, calls `evaluator.ValidateBundleAt` against the copy) →
   `atomicWriteFile` (temp file in the same directory + `os.Rename`, POSIX-atomic within one filesystem).
   `NoopPublisher` is untouched, still in the same file.
3. New `backend-go/services/auth-service/internal/adapter/policypublisher/publisher_test.go` (4 tests):
   - `TestFilePublisher_PublishPolicyChange_RejectsInvalidJSON`
   - `TestFilePublisher_PublishPolicyChange_RejectsBundleCompileFailure` — uses a deliberately-crafted
     bundle (`newConflictingTestBundle`: one Rego module + a bare-scalar `data/ratelimits.json`) where ANY
     candidate write is guaranteed to fail OPA's directory-loader merge (empirically verified: a
     scalar-valued data file can't share a parent directory with any sibling entry), so the test doesn't
     need to depend on the real bundle's rule structure to reliably exercise this path.
   - `TestFilePublisher_PublishPolicyChange_WritesAtomically` — asserts final content matches exactly and
     no leftover temp file remains in the data directory.
   - `TestNoopPublisher_StillWorks` — regression guard for the "kept unmodified" acceptance point.

Results:
- `go build ./...` / `go test ./...` for `common/policy`: clean, all existing tests still pass.
- `go build ./...` / `go test ./...` for `auth-service`: clean, including the 4 new
  `policypublisher` tests.
- Sanity-checked `task-service`, `annotation-service`, `project-service` still `go build ./...` clean
  (all three construct their own `common/policy.Evaluator`).
- `gofmt -l` on every changed file: no output (clean).

## Blocking

Blocked on TASK-BE-024 — DONE in the working tree (`Evaluator.SetCheckPeriod`/`invalidateIfBundleChanged`
exist). Blocks TASK-BE-027 (which wires `FilePublisher` into the CRUD usecases and `main.go`) — left
untouched, next wave.
