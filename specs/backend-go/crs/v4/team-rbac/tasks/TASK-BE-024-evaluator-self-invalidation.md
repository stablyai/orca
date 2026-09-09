# TASK-BE-024: `policy.Evaluator` self-invalidates its prepared-query cache on bundle change

> **Status: ✅ DONE — 2026-09-09**
> **Files modified:** `backend-go/common/policy/evaluator.go`, `backend-go/common/policy/evaluator_test.go`
>
> **Kết quả thực tế:** Implemented exactly per the sketch: `Evaluator` gained `lastChecked`/`lastModHash`/
> `checkPeriod` fields, `preparedQuery` calls `invalidateIfBundleChanged` first, `fingerprintDir` walks the
> bundle path (`filepath.WalkDir`, newest mtime + file count, no content hashing). One naming deviation
> from the sketch's own wording: the "config toggle" for the `checkPeriod:0` rollback path is exposed as a
> `SetCheckPeriod(d time.Duration)` method (called once, after `NewEvaluator`) rather than a
> `NewEvaluator` constructor-argument change — `NewEvaluator(bundlePath string) *Evaluator`'s signature is
> unchanged (defaults to a 2s `checkPeriod`), so all 4 existing call sites
> (`auth-service`/`project-service`/`task-service`/`annotation-service` `cmd/server/main.go`) keep working
> with zero edits, which the acceptance criteria's "no caller anywhere needs to change" implicitly
> requires for `Decision`/`Warm` and this extends the same spirit to `NewEvaluator`. Both `Decision` and
> `Warm` public signatures are byte-for-byte unchanged. Added 2 new integration-style tests
> (`TestEvaluator_InvalidateIfBundleChanged_PicksUpEditWithinCheckPeriod`,
> `TestEvaluator_CheckPeriodZero_PreservesNeverInvalidateBehavior`) against a real temp-dir bundle, both
> pass; the pre-existing `TestEvaluator_Warm_PopulatesCache_DecisionDoesNotRecompile` passes unmodified.
> `go build ./...` clean for the whole repo; `go test ./...` clean for `common/policy` and all 4 consuming
> services. `gofmt -l` clean.

**Solution:** BE-SOL-006 | **CR:** CR-RBAC-006
**Depends on:** none — independent of TASK-BE-025/026/027, though TASK-BE-025 (publisher) and
TASK-BE-027 (wiring) build on this landing first since the whole point of publishing is that it takes
effect via this mechanism.

---

## Goal

`common/policy.Evaluator`'s `preparedQuery` compiles a query once and caches it **forever** — a bundle
edit requires a full service restart today, with no hot-reload watcher. Worse: `project-service`,
`task-service`, and `annotation-service` each construct their **own** `Evaluator` in their **own separate
process**, all reading the same `OPA_BUNDLE_PATH`. Any real fix must work across processes without a
cross-service signal — this task implements that as **self-invalidation inside `Evaluator`**, so every
consumer gets it for free with zero call-site changes.

## What to do

In `backend-go/common/policy/evaluator.go`:

```go
type Evaluator struct {
	bundlePath string

	mu           sync.Mutex
	prepared     map[string]rego.PreparedEvalQuery
	lastChecked  time.Time
	lastModHash  string        // cheap fingerprint: newest mtime + total file count under bundlePath
	checkPeriod  time.Duration // default 2s — bounded staleness, not per-request stat() cost
}

func (e *Evaluator) preparedQuery(ctx context.Context, query string) (rego.PreparedEvalQuery, error) {
	e.invalidateIfBundleChanged()
	e.mu.Lock()
	if pq, ok := e.prepared[query]; ok {
		e.mu.Unlock()
		return pq, nil
	}
	e.mu.Unlock()
	// ... existing rego.New/.../PrepareForEval, then cache ...
}

// invalidateIfBundleChanged clears the prepared-query cache when the bundle
// directory's fingerprint changes — checked at most once per checkPeriod
// (default 2s) to keep the stat() cost off the hot path. This makes a
// policy edit's propagation time bounded by checkPeriod across EVERY
// service reading the same bundle path, with no cross-service signal
// required — each process independently notices its own local copy of the
// (shared-volume/ConfigMap-mounted) bundle changed.
func (e *Evaluator) invalidateIfBundleChanged() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if time.Since(e.lastChecked) < e.checkPeriod {
		return
	}
	e.lastChecked = time.Now()
	hash := fingerprintDir(e.bundlePath) // newest mtime + file count; cheap, no content hashing
	if hash != e.lastModHash {
		e.lastModHash = hash
		e.prepared = map[string]rego.PreparedEvalQuery{} // next preparedQuery call recompiles
	}
}
```

`Decision`/`Warm`'s existing public method **signatures** do not change — only `Evaluator`'s internals
gain this check. Add a config toggle (`checkPeriod: 0` = old never-invalidate behavior) for a safe
rollback path during rollout, per the solution's own explicit recommendation.

## Acceptance Criteria

- [x] `Evaluator.Decision`/`Warm` keep their existing public signatures — no caller anywhere needs to
      change.
- [x] `invalidateIfBundleChanged` checks at most once per `checkPeriod` (default 2s) — verified by test
      that repeated calls within the period don't re-stat the filesystem (observed via `Decision`'s
      outward behavior, the method itself is unexported — see "Kết quả thực tế").
- [x] A bundle file change is picked up within `checkPeriod`, verified by an integration-style test in
      `evaluator_test.go`: write a bundle to a temp dir, `Warm`, call `Decision` once, touch a file under
      the bundle dir, call `Decision` again after `checkPeriod`, assert the new content's effect is
      visible.
- [x] `checkPeriod: 0` preserves the exact old never-invalidate behavior (rollback path).
- [x] `TestEvaluator_Warm_PopulatesCache_DecisionDoesNotRecompile` (existing) still passes unmodified —
      confirms the cache-hit fast path is unaffected within the check window.
- [x] `go build ./...` / `go test ./...` clean for `common/policy` and all 4 services that consume
      `Evaluator` (`auth-service`, `project-service`, `task-service`, `annotation-service`).

## gitnexus

Run in this session (2026-09-09) immediately before editing: `impact({target:"Evaluator",
direction:"upstream", repo:"orca", summaryOnly:true})` → **risk HIGH**, impactedCount 9 (1 direct, 3
processes affected: `auth-service`/`project-service`/`task-service`'s `run` — `annotation-service`'s own
`run` didn't surface in the top-level `affected_processes` list but that service also constructs its own
`Evaluator`, confirmed via `codegraph_explore`/direct read of its `opaclient/client.go`). HIGH reflects
`Evaluator`'s fan-out as the shared authorization-decision primitive in 4 services, not this change's risk
specifically — the change is internal-only (new private fields/methods), `Decision`/`Warm`'s public
signatures are untouched. Landed behind the 2 new unit tests (self-contained, temp-dir bundles) before
TASK-BE-025/027 (not in this Wave-1 batch) would wire a publisher on top. `detect_changes({scope:"compare",
base_ref:"main"})` after landing (run jointly for all 7 Wave-1 tasks) confirms **risk low**, 0 affected
processes broken — all 4 consuming services' `run` steps unaffected.

## Blocking

None structurally, but TASK-BE-025 and TASK-BE-027 are only meaningful once this lands (publishing to a
bundle nothing re-reads is a no-op).
