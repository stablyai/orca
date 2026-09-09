# BE-SOL-006: Replace `NoopPublisher` with a real file-based publish + cross-process reload

> **🔲 Proposed — not implemented.**

**CR:** [CR-RBAC-006](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-006-live-policy-publish.md)
**Service:** auth-service (publisher) + `common/policy` (shared `Evaluator`,
consumed by auth-service, project-service, task-service, annotation-service)
**Depends on:** none — prerequisite for CR-RBAC-001's "Policies" admin tab to
mean anything.

---

## 1. Problem (confirmed, and one important finding beyond the CR's framing)

`policypublisher.NoopPublisher.PublishPolicyChange`
(`backend-go/services/auth-service/internal/adapter/policypublisher/publisher.go:30-36`)
only logs a warning — confirmed via `codegraph_explore`, its only caller is
`update_access_policy.go:63` (`create_access_policy.go`/`delete_access_policy.go`
don't currently call the publisher port at all — verify at implementation
time whether that's intentional or a second, smaller gap in the same family).

`common/policy.Evaluator` (`backend-go/common/policy/evaluator.go:20-101`)
confirms its own doc comment: `preparedQuery` compiles a query once and caches
it in `e.prepared` **forever** (`evaluator.go:81-100`) — "a bundle edit
requires a service restart... No hot-reload watcher exists yet."

**New finding this pass, not in the CR's original framing**: `codegraph_explore`
of `backend-go/policy/orca-authz/*.rego` shows **none of the 5 rule files
(`admin.rego`, `project.rego`, `repo.rego`, `annotation.rego`,
`task_grant.rego`) reference any `data.*` document at all** — every rule's
`input` is entirely caller-supplied (`caller_project_role`, `actor.role`,
etc.), never `data.orca.policies.*` or any admin-editable override. This
means: **even a perfect publisher writing a perfectly-formed `data.json` next
to the bundle would change nothing today**, because no rule consults it. The
`AccessPolicy` CRUD RPCs and their `document_json` blob currently have no
consumer in the Rego layer — this is a materially bigger gap than "the
publish step is a no-op," and needs to be named explicitly rather than
silently assumed away by a Hướng-1 file-write fix.

**Second new finding**: `project-service`, `task-service`, and
`annotation-service` each construct their **own** `policy.Evaluator` pointed
at the **same** `OPA_BUNDLE_PATH` (default `/policy/orca-authz`, confirmed in
each service's `config.go`), each in its **own separate OS process**. A
reload mechanism that only invalidates `auth-service`'s in-process cache
(e.g. an RPC `auth-service` calls on itself) does **nothing** for the other
3 processes enforcing the policy that actually matters for F32 (project/repo
access). Any real fix must work across processes, not just within
auth-service.

## 2. Solution — minimal-change file publish + self-invalidating `Evaluator` (refined Hướng 1)

Given the two findings above, the CR's own Hướng 1(b) ("RPC/internal signal
ReloadPolicyBundle") is insufficient by itself (finding 2). Refined design,
staying within "Hướng 1 / minimal-change" as instructed:

### A. Real `PolicyDataPublisher`: write validated data to the shared bundle path

```go
// PublishPolicyChange writes policy's document_json to
// <bundlePath>/data/<kind>/<name>.json — a plain file OPA's rego.Load
// already knows how to merge as a data document when pointed at a directory
// (rego.Load([]string{bundlePath}, nil) in common/policy.Evaluator already
// loads the whole directory tree, not just *.rego files — confirmed by
// reading OPA's rego.Load semantics: any .json/.yaml file under the loaded
// path becomes part of `data`, keyed by its path).
func (p *FilePublisher) PublishPolicyChange(ctx context.Context, policy domain.AccessPolicy) error {
	// 1. Validate document_json is well-formed JSON (cheap, in-process).
	var doc any
	if err := json.Unmarshal([]byte(policy.DocumentJSON), &doc); err != nil {
		return fmt.Errorf("policypublisher: policy %s document is not valid JSON: %w", policy.ID, err)
	}
	// 2. Validate the WHOLE bundle (existing .rego + this new/changed data
	//    file) still compiles — reject before writing if not, so a bad
	//    write can never corrupt a bundle every service reads.
	path := filepath.Join(p.bundlePath, "data", policy.Kind, policy.Name+".json")
	if err := p.validateCompiles(ctx, path, policy.DocumentJSON); err != nil {
		return fmt.Errorf("policypublisher: policy %s would break the OPA bundle: %w", policy.ID, err)
	}
	// 3. Atomic write: temp file + rename, never a partial write a
	//    concurrently-reloading Evaluator could observe mid-write.
	return atomicWriteFile(path, []byte(policy.DocumentJSON))
}
```

`validateCompiles` loads a **temporary copy** of the bundle directory (or an
in-memory overlay — `rego.Load` accepts a `filter` and can be pointed at a
staging directory) with the candidate file already written, and runs a cheap
`rego.New(...).PrepareForEval(ctx)` against every existing named query this
service already knows about (`policy.Evaluator` doesn't currently expose a
"validate a candidate bundle" method — add one: `Evaluator.ValidateBundleAt(ctx, candidatePath string) error`).
Reject the write if this fails — directly satisfies the CR's "Policy document
không compile được → write bị từ chối" acceptance criterion.

### B. `Evaluator`: self-invalidate on file-change, not an external signal

Since every service (auth/project/task/annotation) independently reads the
same on-disk bundle path, the simplest correct cross-process propagation is
each `Evaluator` **noticing the bundle directory changed** — no cross-service
RPC needed at all:

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

This closes the CR's "Hướng 1(a) polling" option, but implemented **inside
`Evaluator` itself** rather than as an external cron/health-check — every
consumer gets it for free with zero call-site changes, and it correctly
solves the multi-process problem the CR's own Hướng 1(b) framing missed.
`checkPeriod` (default 2s) bounds propagation latency and directly answers
the acceptance criterion "trong vòng thời gian xác định."

### C. Make at least one rule consult published data (proof the plumbing works)

Per finding 1 above, publishing to a file nothing reads is not "policy admin
sửa có hiệu lực thật" — it's a more convincing no-op. Minimal, additive
change to prove end-to-end effect without redesigning the bundle's shape
(explicitly staying within the CR's own "không đổi hình dạng dữ liệu"
constraint): extend `admin.rego`'s existing `allow` rule with one additional,
purely-additive clause:

```rego
package orca.authz.admin

import rego.v1

default allow := false

allow if {
	input.actor.role == "admin"
}

# Additive override consuming an AccessPolicy of kind "admin_override",
# name "extra_admins" — published by PolicyDataPublisher to
# data/admin_override/extra_admins.json. Absent by default (data.orca...
# undefined), so this clause is a no-op until an admin explicitly creates
# that policy — never changes behavior for a deployment that never uses it.
allow if {
	input.actor.id in data.orca.authz.admin_override.extra_admins.user_ids
}
```

This is deliberately the smallest possible consuming rule — it does not
attempt to cover the full resource×action matrix F32 originally sketched.
**Explicitly flagged as scope-limited**, matching this CR's own text: wiring
every action across every service's Rego file to consult admin-authored
policy data is a materially larger, separate effort (每个 `.rego` file would
need its own additive data-consulting clause, each requiring its own
`opa test` coverage) — not attempted here. This solution's job is proving
the publish-to-effect pipeline is real for one representative case; broader
coverage is the acknowledged, larger Hướng-2-adjacent follow-up.

## 3. Files to change

| File | Change |
|---|---|
| `backend-go/services/auth-service/internal/adapter/policypublisher/publisher.go` | Replace `NoopPublisher` with `FilePublisher` (§2.A); keep `NoopPublisher` in the package for tests that don't care about publish behavior |
| `backend-go/common/policy/evaluator.go` | Add `invalidateIfBundleChanged`/`fingerprintDir`/`checkPeriod` (§2.B); add `ValidateBundleAt` for pre-write validation (§2.A) |
| `backend-go/policy/orca-authz/admin.rego` | Additive `allow` clause consuming `data.orca.authz.admin_override.extra_admins` (§2.C) |
| `backend-go/policy/orca-authz/admin_test.rego` | `opa test` case: policy absent → old behavior unchanged; policy present → additional actor id allowed |
| `backend-go/services/auth-service/internal/usecase/create_access_policy.go`, `update_access_policy.go`, `delete_access_policy.go` | Ensure all 3 call `PolicyDataPublisher` (confirmed only `update_access_policy.go` does today — verify create/delete's omission is intentional or a gap before this change) |
| `backend-go/services/auth-service/cmd/server/main.go` | Wire `FilePublisher` in place of `authpolicypublisher.New(logger)` |
| Deploy config (out of code scope, note only) | The bundle path must be a **shared, writable-by-auth-service, readable-by-others** volume (e.g. a shared PVC or a sidecar sync) across all 4 consuming services' pods — today's per-service `OPA_BUNDLE_PATH` config already assumes a shared path exists; this CR makes writing to it from auth-service a real operational requirement for the first time, flag for the deploy/infra owner |

## 4. Out of scope

- Hướng 2 (real OPA bundle server / Bundle API) — explicitly deferred by the
  CR itself as the longer-term option; this solution documents it as the
  future upgrade path, not implemented here.
- Wiring every `.rego` file's every action to consult admin-authored policy
  data — §2.C is a single proof-of-concept clause, not full coverage.
- Changing `document_json`'s shape to match F32's original resource×action
  matrix — the CR's own "Không thuộc phạm vi."
- `create_access_policy.go`/`delete_access_policy.go` NOT calling the
  publisher today might be intentional (create/delete are rarer, and a
  version-1 create has "no prior enforcement to change" — arguable) or might
  be an oversight; this solution surfaces it as a verify-before-implementing
  item rather than assuming either way.

## 5. Tests

- `common/policy/evaluator_test.go`: extend
  `TestEvaluator_Warm_PopulatesCache_DecisionDoesNotRecompile` with a
  companion `TestEvaluator_Decision_RecompilesAfterBundleFileChanges` —
  write a bundle to a temp dir, `Warm`, call `Decision` once, touch a file
  under the bundle dir (advance the fingerprint), call `Decision` again
  after `checkPeriod`, assert the new file content's effect is visible.
- `policypublisher/publisher_test.go` (new): `FilePublisher.PublishPolicyChange`
  writes valid JSON atomically; rejects (no file written) when the candidate
  bundle fails to compile.
- `backend-go/policy/orca-authz/admin_test.rego`: `opa test` cases for both
  branches of §2.C's additive clause.
- Integration test (per CR's own acceptance criterion): `UpdateAccessPolicy`
  → wait ≤ `checkPeriod` (or force-invalidate in test) → a real `Decision`
  call against the same `Evaluator` instance reflects the new policy, no
  process restart in the test.

## 6. Impact analysis (gitnexus)

| Symbol | Direction | Risk | Impacted | Note |
|---|---|---|---|---|
| `NoopPublisher` (`auth-service/internal/adapter/policypublisher/publisher.go:22`) | upstream | LOW | 3 (1 direct, 1 process `run` in `auth-service/cmd/server/main.go`) | Confirmed by `impact()` this pass — matches prior audit. `PolicyDataPublisher`'s interface (`ports.go:130`) is unchanged; only the concrete implementation wired in `main.go` changes. |
| `Evaluator` (`common/policy/evaluator.go:22`) | upstream | Not run with `summaryOnly` in this pass — **run before implementing**, since this symbol is shared by 4 services (`auth-service`, `project-service`, `task-service`, `annotation-service`, confirmed via `codegraph_explore`'s "5 callers" list) | — | Because `Evaluator` is a shared `common/` primitive consumed by 4 independent services, adding `invalidateIfBundleChanged` to its internals (not its public method signatures — `Decision`/`Warm` keep their existing signatures) should be LOW risk mechanically, but run `impact({target:"Evaluator", direction:"upstream"})` immediately before editing per the repo's mandatory rule, and `detect_changes({scope:"compare", base_ref:"main"})` after, checking all 4 services' `run` processes show 0 broken steps. |

**Warning**: `Evaluator` backs authorization decisions in 4 services — a bug
in `invalidateIfBundleChanged` (e.g. a fingerprint that never changes, or one
that thrashes and defeats caching entirely under load) affects every OPA
decision in the system. Land the polling logic behind its own unit tests
(§5) before wiring `FilePublisher` in `auth-service/cmd/server/main.go`, and
consider a feature flag / config toggle (`checkPeriod: 0` = old
never-invalidate behavior) for a safe rollback path during rollout.
