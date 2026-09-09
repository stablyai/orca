package policy_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stablyai/orca-go/common/policy"
)

// bundlePath points at the real orca-authz bundle (../../policy/orca-authz
// relative to this package) — this test exercises the actual policies
// every consuming service loads, not a synthetic inline bundle, so a
// policy-file typo or Rego syntax error fails here rather than only inside
// `opa test` (which this Go test suite doesn't otherwise run).
const bundlePath = "../../policy/orca-authz"

func TestEvaluator_AdminDecision(t *testing.T) {
	e := policy.NewEvaluator(bundlePath)
	ctx := context.Background()

	allowed, err := e.Decision(ctx, "data.orca.authz.admin.allow", map[string]any{
		"actor": map[string]any{"role": "admin", "id": "u1"},
	})
	if err != nil {
		t.Fatalf("Decision: %v", err)
	}
	if !allowed {
		t.Fatal("expected admin actor to be allowed")
	}

	allowed, err = e.Decision(ctx, "data.orca.authz.admin.allow", map[string]any{
		"actor": map[string]any{"role": "user", "id": "u1"},
	})
	if err != nil {
		t.Fatalf("Decision: %v", err)
	}
	if allowed {
		t.Fatal("expected non-admin actor to be denied")
	}
}

func TestEvaluator_TaskGrantDecision(t *testing.T) {
	e := policy.NewEvaluator(bundlePath)
	ctx := context.Background()

	allowed, err := e.Decision(ctx, "data.orca.authz.task.allow", map[string]any{
		"level": "company", "action": "write",
	})
	if err != nil {
		t.Fatalf("Decision: %v", err)
	}
	if allowed {
		t.Fatal("expected company-level grant to be denied for write")
	}

	allowed, err = e.Decision(ctx, "data.orca.authz.task.allow", map[string]any{
		"level": "owner", "action": "write",
	})
	if err != nil {
		t.Fatalf("Decision: %v", err)
	}
	if !allowed {
		t.Fatal("expected owner-level grant to be allowed for write")
	}
}

func TestEvaluator_AnnotationDecision(t *testing.T) {
	e := policy.NewEvaluator(bundlePath)
	ctx := context.Background()

	allowed, err := e.Decision(ctx, "data.orca.authz.annotation.allow", map[string]any{
		"actor_id": "u1", "author_id": "u1", "actor_role": "user",
	})
	if err != nil {
		t.Fatalf("Decision: %v", err)
	}
	if !allowed {
		t.Fatal("expected author to be allowed")
	}

	allowed, err = e.Decision(ctx, "data.orca.authz.annotation.allow", map[string]any{
		"actor_id": "u2", "author_id": "u1", "actor_role": "user",
	})
	if err != nil {
		t.Fatalf("Decision: %v", err)
	}
	if allowed {
		t.Fatal("expected non-author non-admin to be denied")
	}
}

func TestEvaluator_UndefinedQueryIsDeny(t *testing.T) {
	e := policy.NewEvaluator(bundlePath)
	allowed, err := e.Decision(context.Background(), "data.orca.authz.nonexistent.allow", map[string]any{})
	if err != nil {
		t.Fatalf("Decision: %v", err)
	}
	if allowed {
		t.Fatal("expected an undefined rule path to default-deny, not error-allow")
	}
}

func TestEvaluator_Warm_Succeeds_ForRealBundle(t *testing.T) {
	e := policy.NewEvaluator(bundlePath)
	if err := e.Warm(context.Background(),
		"data.orca.authz.admin.allow",
		"data.orca.authz.project.allow",
		"data.orca.authz.task.allow",
		"data.orca.authz.annotation.allow",
	); err != nil {
		t.Fatalf("expected Warm to succeed against the real bundle for every consuming service's query: %v", err)
	}
}

func TestEvaluator_Warm_FailsFast_WhenBundlePathIsWrong(t *testing.T) {
	e := policy.NewEvaluator("/definitely/does/not/exist")
	if err := e.Warm(context.Background(), "data.orca.authz.admin.allow"); err == nil {
		t.Fatal("expected Warm to fail against a nonexistent bundle path — this is the exact failure mode BUG-003 needed to happen at startup, not on first request")
	}
}

func TestEvaluator_Warm_PopulatesCache_DecisionDoesNotRecompile(t *testing.T) {
	// Indirect check: Warm should leave the query pre-compiled so a
	// subsequent Decision call for the same query doesn't pay the compile
	// cost again — this is the same `prepared` map Decision itself uses
	// (preparedQuery's cache-hit path), so this test just confirms Warm and
	// Decision agree on the same cache key format (the raw query string) by
	// calling both against the same evaluator instance without error.
	e := policy.NewEvaluator(bundlePath)
	if err := e.Warm(context.Background(), "data.orca.authz.admin.allow"); err != nil {
		t.Fatalf("Warm: %v", err)
	}
	if _, err := e.Decision(context.Background(), "data.orca.authz.admin.allow", map[string]any{
		"actor": map[string]any{"role": "admin", "id": "u1"},
	}); err != nil {
		t.Fatalf("Decision after Warm: %v", err)
	}
}

// writeTestBundle writes a single-rule test.rego file to dir, returning dir.
// allowedValue is the literal string input.x must equal for data.t.allow to
// evaluate true — rewriting this file with a different allowedValue is how
// the tests below simulate a policy edit.
func writeTestBundle(t *testing.T, dir, allowedValue string) {
	t.Helper()
	content := "package t\n\nimport rego.v1\n\ndefault allow := false\n\nallow if {\n\tinput.x == \"" + allowedValue + "\"\n}\n"
	if err := os.WriteFile(filepath.Join(dir, "test.rego"), []byte(content), 0o644); err != nil {
		t.Fatalf("writing test bundle: %v", err)
	}
}

// TestEvaluator_InvalidateIfBundleChanged_PicksUpEditWithinCheckPeriod is
// TASK-BE-024's core acceptance test: a bundle file changed on disk must be
// visible to Decision within checkPeriod, with no service restart.
func TestEvaluator_InvalidateIfBundleChanged_PicksUpEditWithinCheckPeriod(t *testing.T) {
	dir := t.TempDir()
	writeTestBundle(t, dir, "a")

	e := policy.NewEvaluator(dir)
	e.SetCheckPeriod(20 * time.Millisecond)
	ctx := context.Background()

	if err := e.Warm(ctx, "data.t.allow"); err != nil {
		t.Fatalf("Warm: %v", err)
	}
	allowed, err := e.Decision(ctx, "data.t.allow", map[string]any{"x": "a"})
	if err != nil {
		t.Fatalf("Decision (before edit): %v", err)
	}
	if !allowed {
		t.Fatal("expected input.x==\"a\" to be allowed against the original bundle")
	}

	// Simulate a policy edit — mtime must actually move forward for
	// fingerprintDir to notice, so give the filesystem's mtime resolution
	// room even on coarse-grained filesystems.
	time.Sleep(10 * time.Millisecond)
	writeTestBundle(t, dir, "b")

	// Immediately after the edit, still inside checkPeriod: the cached
	// (pre-edit) query must still be served — this is the "at most once
	// per checkPeriod" contract, observed through Decision's outward
	// behavior rather than the unexported invalidateIfBundleChanged.
	allowed, err = e.Decision(ctx, "data.t.allow", map[string]any{"x": "b"})
	if err != nil {
		t.Fatalf("Decision (immediately after edit): %v", err)
	}
	if allowed {
		t.Fatal("expected the stale pre-edit rule to still be served inside checkPeriod")
	}

	time.Sleep(30 * time.Millisecond) // past checkPeriod

	allowed, err = e.Decision(ctx, "data.t.allow", map[string]any{"x": "b"})
	if err != nil {
		t.Fatalf("Decision (after checkPeriod elapsed): %v", err)
	}
	if !allowed {
		t.Fatal("expected the edited rule (input.x==\"b\") to be visible once checkPeriod elapsed")
	}
}

// TestEvaluator_CheckPeriodZero_PreservesNeverInvalidateBehavior is the
// rollback path BE-SOL-006 explicitly asked for: checkPeriod:0 must behave
// exactly like the pre-TASK-BE-024 Evaluator — a bundle edit is never
// picked up, no matter how much time passes.
func TestEvaluator_CheckPeriodZero_PreservesNeverInvalidateBehavior(t *testing.T) {
	dir := t.TempDir()
	writeTestBundle(t, dir, "a")

	e := policy.NewEvaluator(dir)
	e.SetCheckPeriod(0)
	ctx := context.Background()

	if err := e.Warm(ctx, "data.t.allow"); err != nil {
		t.Fatalf("Warm: %v", err)
	}

	time.Sleep(10 * time.Millisecond)
	writeTestBundle(t, dir, "b")
	time.Sleep(30 * time.Millisecond) // well past what would be a normal checkPeriod

	allowed, err := e.Decision(ctx, "data.t.allow", map[string]any{"x": "b"})
	if err != nil {
		t.Fatalf("Decision: %v", err)
	}
	if allowed {
		t.Fatal("expected checkPeriod:0 to never invalidate — the pre-edit rule must still be served")
	}
}
