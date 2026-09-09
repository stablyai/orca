// Package policy is the shared, embedded OPA evaluation code Epic E's
// consuming services (auth-service, task-service, annotation-service) all
// use to query the orca-authz Rego bundle in-process — no sidecar, no
// network hop, per
// specs/backend-go/architecture/07-security-architecture.md's requirement
// that every service's fine-grained authorization check run "embedded,
// in-process." Each service constructs its own Evaluator pointed at the
// same bundle path and queries its own rule (e.g.
// "data.orca.authz.admin.allow") — one bundle, many entry-point rules.
package policy

import (
	"context"
	"fmt"
	"io/fs"
	"path/filepath"
	"sync"
	"time"

	"github.com/open-policy-agent/opa/rego"
)

// defaultCheckPeriod bounds how often invalidateIfBundleChanged re-stats the
// bundle directory — a policy edit's propagation time across every service
// reading the same bundle path, per that method's doc comment.
const defaultCheckPeriod = 2 * time.Second

// Evaluator loads the orca-authz Rego bundle from bundlePath and evaluates
// named boolean queries against it.
type Evaluator struct {
	bundlePath string

	mu          sync.Mutex
	prepared    map[string]rego.PreparedEvalQuery
	lastChecked time.Time
	lastModHash string        // cheap fingerprint: newest mtime + total file count under bundlePath
	checkPeriod time.Duration // 0 = old never-invalidate behavior (rollback path, see SetCheckPeriod)
}

// NewEvaluator points an Evaluator at a Rego bundle directory (or a single
// .rego file) on disk. Self-invalidates its prepared-query cache at most
// once per defaultCheckPeriod (TASK-BE-024/CR-RBAC-006) — use
// SetCheckPeriod to change that interval, or set it to 0 for the pre-#TASK-BE-024
// never-invalidate behavior (a safe rollback path during rollout, per
// BE-SOL-006's own recommendation).
func NewEvaluator(bundlePath string) *Evaluator {
	return &Evaluator{bundlePath: bundlePath, prepared: map[string]rego.PreparedEvalQuery{}, checkPeriod: defaultCheckPeriod}
}

// SetCheckPeriod overrides how often invalidateIfBundleChanged re-stats the
// bundle directory. Not required at construction time — call it once, right
// after NewEvaluator, if a deployment needs a different interval or the
// checkPeriod:0 rollback path. Safe to call before any Decision/Warm call;
// concurrent use with an in-flight Decision/Warm call is not supported (same
// single-goroutine-setup convention as bundlePath itself).
func (e *Evaluator) SetCheckPeriod(d time.Duration) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.checkPeriod = d
}

// Decision evaluates the fully-qualified rule path query (e.g.
// "data.orca.authz.admin.allow") against input and reports whether it
// resolved to exactly `true`. Undefined, false, a non-boolean result, or an
// evaluation error are all treated as deny — this package has no
// partial-allow concept; callers get a plain bool and, on error, must
// decide their own fail-closed behavior (every Epic E call site in this
// system fails closed on a non-nil error, matching the fail-closed policy
// this codebase's other credential/permission checks already use).
//
// The bundle is compiled once per distinct query string and the prepared
// query is cached until invalidateIfBundleChanged notices the bundle
// directory's fingerprint changed (checked at most once per checkPeriod,
// default 2s — see that method's doc comment) — a bundle edit's
// propagation time is bounded by checkPeriod, not a full service restart.
func (e *Evaluator) Decision(ctx context.Context, query string, input any) (bool, error) {
	pq, err := e.preparedQuery(ctx, query)
	if err != nil {
		return false, err
	}
	rs, err := pq.Eval(ctx, rego.EvalInput(input))
	if err != nil {
		return false, fmt.Errorf("policy: evaluating query %q: %w", query, err)
	}
	if len(rs) == 0 || len(rs[0].Expressions) == 0 {
		return false, nil // undefined result (no matching rule) — default deny
	}
	allowed, ok := rs[0].Expressions[0].Value.(bool)
	if !ok {
		return false, fmt.Errorf("policy: query %q returned non-boolean result %T", query, rs[0].Expressions[0].Value)
	}
	return allowed, nil
}

// Warm eagerly compiles every named query — call once at service startup,
// right after NewEvaluator, so a missing/unreadable/invalid bundle fails
// loudly at boot instead of surfacing as an opaque per-request evaluation
// error the first time a real caller happens to hit an OPA-gated RPC (see
// specs/backend-go/bugs/missing-v2/BUG-003).
func (e *Evaluator) Warm(ctx context.Context, queries ...string) error {
	for _, q := range queries {
		if _, err := e.preparedQuery(ctx, q); err != nil {
			return fmt.Errorf("policy: warming query %q: %w", q, err)
		}
	}
	return nil
}

// ValidateBundleAt loads a candidate bundle directory (or a single .rego/
// data file) at candidatePath and confirms it still compiles — used by
// policypublisher.FilePublisher (TASK-BE-025/CR-RBAC-006) to reject a data
// write that would break the OPA bundle every service reads, before that
// write ever touches the real, shared bundle path. Deliberately builds a
// brand-new, standalone rego.New/PrepareForEval call scoped to candidatePath
// — it never reads or writes e.mu/e.prepared/e.bundlePath/e.lastModHash, so
// validating an unrelated candidate path can never affect this Evaluator's
// own cached decisions or force a real service's next Decision/Warm call to
// recompile. OPA's compiler validates every loaded module together as one
// unit regardless of which rule is queried, so querying the bare "data"
// document is enough to surface a compile error anywhere in the bundle, not
// just under whatever rule "data" itself would resolve to.
func (e *Evaluator) ValidateBundleAt(ctx context.Context, candidatePath string) error {
	_, err := rego.New(
		rego.Query("data"),
		rego.Load([]string{candidatePath}, nil),
	).PrepareForEval(ctx)
	if err != nil {
		return fmt.Errorf("policy: validating candidate bundle at %s: %w", candidatePath, err)
	}
	return nil
}

func (e *Evaluator) preparedQuery(ctx context.Context, query string) (rego.PreparedEvalQuery, error) {
	e.invalidateIfBundleChanged()

	e.mu.Lock()
	if pq, ok := e.prepared[query]; ok {
		e.mu.Unlock()
		return pq, nil
	}
	e.mu.Unlock()

	pq, err := rego.New(
		rego.Query(query),
		rego.Load([]string{e.bundlePath}, nil),
	).PrepareForEval(ctx)
	if err != nil {
		return rego.PreparedEvalQuery{}, fmt.Errorf("policy: preparing query %q against bundle %s: %w", query, e.bundlePath, err)
	}

	e.mu.Lock()
	e.prepared[query] = pq
	e.mu.Unlock()
	return pq, nil
}

// invalidateIfBundleChanged clears the prepared-query cache when the bundle
// directory's fingerprint changes — checked at most once per checkPeriod
// (default 2s, see defaultCheckPeriod) to keep the stat() cost off the hot
// path. This makes a policy edit's propagation time bounded by checkPeriod
// across EVERY service reading the same bundle path, with no cross-service
// signal required — each process independently notices its own local copy
// of the (shared-volume/ConfigMap-mounted) bundle changed. checkPeriod == 0
// disables this entirely (the pre-TASK-BE-024 never-invalidate behavior),
// per SetCheckPeriod's doc comment.
func (e *Evaluator) invalidateIfBundleChanged() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.checkPeriod <= 0 {
		return
	}
	if time.Since(e.lastChecked) < e.checkPeriod {
		return
	}
	e.lastChecked = time.Now()
	hash := fingerprintDir(e.bundlePath)
	if hash != e.lastModHash {
		e.lastModHash = hash
		e.prepared = map[string]rego.PreparedEvalQuery{} // next preparedQuery call recompiles
	}
}

// fingerprintDir is a cheap, no-content-hashing fingerprint of bundlePath:
// the newest modification time plus the total file count found under it.
// Good enough to detect "something under this directory changed" (an edit,
// an add, a delete) without reading file contents on every check — a false
// negative (a change that doesn't move either number, e.g. two files
// swapping content of the same size at the same mtime second) is an
// accepted, deliberately narrow gap for this cheap a check; a full content
// hash would defeat the point of keeping this off the hot path. Works
// whether bundlePath is a directory or a single .rego file (NewEvaluator's
// doc comment allows both).
func fingerprintDir(root string) string {
	var newest time.Time
	var count int
	_ = filepath.WalkDir(root, func(_ string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil //nolint:nilerr // best-effort fingerprint — an unreadable entry just doesn't count toward it
		}
		count++
		if info, ierr := d.Info(); ierr == nil && info.ModTime().After(newest) {
			newest = info.ModTime()
		}
		return nil
	})
	return fmt.Sprintf("%d:%d", newest.UnixNano(), count)
}
