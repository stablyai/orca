package usecase

// This file is the integration test TASK-BE-027/CR-RBAC-006 explicitly asks
// for: CreateAccessPolicy/UpdateAccessPolicy, wired to a REAL
// policypublisher.FilePublisher and a REAL common/policy.Evaluator (not
// fakes), demonstrate that a policy change becomes visible to a live
// Decision call against that SAME Evaluator instance within checkPeriod —
// with no process restart in the test. This _test.go file is the only place
// in this package that imports the adapter package (policypublisher) —
// never done in production code (ports.go's PolicyDataPublisher interface
// is how usecase/ stays adapter-agnostic per
// 03-clean-architecture-guidelines.md); a _test.go file is never compiled
// into the production binary, so this doesn't violate that rule.

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stablyai/orca-go/common/policy"
	"github.com/stablyai/orca-go/services/auth-service/internal/adapter/policypublisher"
	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
)

// writePublishAwareTestRule writes a rego rule that consults whatever
// FilePublisher would write for a policy of kind="testkind" — a JSON data
// file at <bundlePath>/data/testkind/<name>.json. Empirically confirmed
// (rather than assumed) against this OPA version: plain rego.Load (what
// common/policy.Evaluator uses — no bundle/.manifest semantics) merges a
// JSON data file's own top-level keys directly at the path of its
// ENCLOSING DIRECTORY, with the file's own basename contributing NO path
// segment of its own. So a file at <root>/data/testkind/<anyname>.json
// with content {"allowed_value": "x"} resolves to
// data.data.testkind.allowed_value — not data.<kind>.<name>.allowed_value
// and not data.orca.authz.<kind>.<name> as admin.rego's own TASK-BE-026
// comment assumes (a discrepancy worth flagging there, out of this task's
// scope to fix).
func writePublishAwareTestRule(t *testing.T, dir string) {
	t.Helper()
	content := "package t\n\nimport rego.v1\n\ndefault allow := false\n\nallow if {\n\tinput.x == data.data.testkind.allowed_value\n}\n"
	if err := os.WriteFile(filepath.Join(dir, "test.rego"), []byte(content), 0o644); err != nil {
		t.Fatalf("writing test rule: %v", err)
	}
}

func TestUpdateAccessPolicy_PublishedChange_VisibleToLiveEvaluator_NoRestart(t *testing.T) {
	dir := t.TempDir()
	writePublishAwareTestRule(t, dir)

	evaluator := policy.NewEvaluator(dir)
	evaluator.SetCheckPeriod(20 * time.Millisecond) // fast, deterministic test — mirrors TestEvaluator_InvalidateIfBundleChanged_PicksUpEditWithinCheckPeriod
	ctx := context.Background()
	if err := evaluator.Warm(ctx, "data.t.allow"); err != nil {
		t.Fatalf("Warm: %v", err)
	}

	// Before any policy is published, the rule's data dependency is
	// undefined, so it must default-deny for every input.
	allowed, err := evaluator.Decision(ctx, "data.t.allow", map[string]any{"x": "a"})
	if err != nil {
		t.Fatalf("Decision (before publish): %v", err)
	}
	if allowed {
		t.Fatal("expected default-deny before any policy was ever published")
	}

	publisher := policypublisher.NewFilePublisher(dir, evaluator)
	users := newFakeUserRepository()
	seedActiveUser(t, users, fakeHasher{}, "admin1", "t1", "admin@example.com", "pw", domain.RoleAdmin)
	policies := newFakeAccessPolicyRepository()
	clock := &fakeClock{now: time.Now()}
	opa := &fakeOPAClient{allow: true}
	actorCtx := withActor(context.Background(), "t1", "admin1")

	create := NewCreateAccessPolicy(users, policies, publisher, clock, opa)
	created, err := create.Execute(actorCtx, CreateAccessPolicyInput{
		Name: "testname", Kind: "testkind", DocumentJSON: `{"allowed_value":"a"}`,
	})
	if err != nil {
		t.Fatalf("CreateAccessPolicy: %v", err)
	}

	// checkPeriod hasn't elapsed yet — the create's publish must not be
	// visible immediately (same "at most once per checkPeriod" contract
	// TASK-BE-024's own Evaluator test asserts).
	allowed, err = evaluator.Decision(ctx, "data.t.allow", map[string]any{"x": "a"})
	if err != nil {
		t.Fatalf("Decision (immediately after create): %v", err)
	}
	if allowed {
		t.Fatal("expected the just-published create to still be invisible inside checkPeriod")
	}

	time.Sleep(30 * time.Millisecond) // past checkPeriod
	allowed, err = evaluator.Decision(ctx, "data.t.allow", map[string]any{"x": "a"})
	if err != nil {
		t.Fatalf("Decision (after checkPeriod, post-create): %v", err)
	}
	if !allowed {
		t.Fatal("expected the created policy's published value \"a\" to be visible once checkPeriod elapsed, no restart")
	}

	// Now update the SAME policy id to a new value and confirm the SAME
	// live Evaluator instance picks it up too, with no process restart.
	update := NewUpdateAccessPolicy(users, policies, publisher, clock, opa)
	if _, err := update.Execute(actorCtx, created.ID, `{"allowed_value":"b"}`, 1); err != nil {
		t.Fatalf("UpdateAccessPolicy: %v", err)
	}

	allowed, err = evaluator.Decision(ctx, "data.t.allow", map[string]any{"x": "b"})
	if err != nil {
		t.Fatalf("Decision (immediately after update): %v", err)
	}
	if allowed {
		t.Fatal("expected the just-published update to still be invisible inside checkPeriod")
	}
	allowed, err = evaluator.Decision(ctx, "data.t.allow", map[string]any{"x": "a"})
	if err != nil {
		t.Fatalf("Decision (immediately after update, stale value): %v", err)
	}
	if !allowed {
		t.Fatal("expected the stale pre-update value \"a\" to still be served inside checkPeriod")
	}

	time.Sleep(30 * time.Millisecond) // past checkPeriod
	allowed, err = evaluator.Decision(ctx, "data.t.allow", map[string]any{"x": "b"})
	if err != nil {
		t.Fatalf("Decision (after checkPeriod, post-update): %v", err)
	}
	if !allowed {
		t.Fatal("expected the updated policy's new value \"b\" to be visible once checkPeriod elapsed, no restart")
	}
	allowed, err = evaluator.Decision(ctx, "data.t.allow", map[string]any{"x": "a"})
	if err != nil {
		t.Fatalf("Decision (after checkPeriod, old value): %v", err)
	}
	if allowed {
		t.Fatal("expected the pre-update value \"a\" to no longer be allowed once the update propagated")
	}
}
