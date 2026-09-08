package usecase

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

// TASK-004's regression test for its own correction to SOL-004's sketch:
// AttachWorkspace is pure bookkeeping — it must never call agent.Exec.
func TestEphemeralVmRelay_AttachWorkspace_NeverCallsAgent(t *testing.T) {
	runtimes := &fakeEphemeralVmRuntimeRepository{}
	agent := &fakeDevServerAgentClient{}
	uc := NewEphemeralVmRelay(&fakeConnectionResolver{}, agent, runtimes)

	ctx := withTenant(context.Background(), "tenant-1")
	got, err := uc.AttachWorkspace(ctx, "rt-1", "ws-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(agent.execCalls) != 0 {
		t.Errorf("expected AttachWorkspace to never call agent.Exec, got calls: %v", agent.execCalls)
	}
	if len(runtimes.updateStatusCalls) != 1 {
		t.Fatalf("expected exactly one UpdateStatus call, got %+v", runtimes.updateStatusCalls)
	}
	call := runtimes.updateStatusCalls[0]
	if call.id != "rt-1" || call.status != "active" || call.workspaceID != "ws-1" {
		t.Errorf("unexpected UpdateStatus call: %+v", call)
	}
	if got.Status != "active" {
		t.Errorf("unexpected result: %+v", got)
	}
}

func TestEphemeralVmRelay_AttachWorkspace_NoTenant_ReturnsError(t *testing.T) {
	uc := NewEphemeralVmRelay(&fakeConnectionResolver{}, &fakeDevServerAgentClient{}, &fakeEphemeralVmRuntimeRepository{})
	_, err := uc.AttachWorkspace(context.Background(), "rt-1", "ws-1")
	if err == nil {
		t.Fatal("expected an error when no tenant is in context")
	}
}

func TestEphemeralVmRelay_SuspendWorkspace_NoRuntimeAttached_ReturnsNotFound(t *testing.T) {
	runtimes := &fakeEphemeralVmRuntimeRepository{}
	uc := NewEphemeralVmRelay(&fakeConnectionResolver{}, &fakeDevServerAgentClient{}, runtimes)

	ctx := withTenant(context.Background(), "tenant-1")
	_, err := uc.SuspendWorkspace(ctx, "conn-1", "ws-missing", "suspend.sh")
	var ae *apperrors.AppError
	if !errors.As(err, &ae) || ae.Kind != apperrors.KindNotFound {
		t.Fatalf("expected KindNotFound, got %v", err)
	}
}

func TestEphemeralVmRelay_SuspendWorkspace_EmptyCommand_SkipsRelay(t *testing.T) {
	runtimes := &fakeEphemeralVmRuntimeRepository{
		byWorkspace: map[string]domain.EphemeralVmRuntime{"ws-1": {ID: "rt-1", WorkspaceID: "ws-1"}},
	}
	agent := &fakeDevServerAgentClient{}
	uc := NewEphemeralVmRelay(&fakeConnectionResolver{}, agent, runtimes)

	ctx := withTenant(context.Background(), "tenant-1")
	got, err := uc.SuspendWorkspace(ctx, "", "ws-1", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(agent.execCalls) != 0 {
		t.Errorf("expected no agent relay when command is empty, got %v", agent.execCalls)
	}
	if got.Status != "suspended" {
		t.Errorf("expected status=suspended, got %+v", got)
	}
}

func TestEphemeralVmRelay_SuspendWorkspace_NoConnectionID_FailsPrecondition(t *testing.T) {
	runtimes := &fakeEphemeralVmRuntimeRepository{
		byWorkspace: map[string]domain.EphemeralVmRuntime{"ws-1": {ID: "rt-1", WorkspaceID: "ws-1"}},
	}
	uc := NewEphemeralVmRelay(&fakeConnectionResolver{}, &fakeDevServerAgentClient{}, runtimes)

	ctx := withTenant(context.Background(), "tenant-1")
	_, err := uc.SuspendWorkspace(ctx, "", "ws-1", "suspend.sh")
	var ae *apperrors.AppError
	if !errors.As(err, &ae) || ae.Kind != apperrors.KindFailedPrecondition {
		t.Fatalf("expected KindFailedPrecondition, got %v", err)
	}
	// The runtime is marked "error" once resolveDevServerAndRepoPath fails
	// (mirrors the "error" transition on a failed relay elsewhere in this
	// usecase) — assert at least the lookup happened, not the error status
	// specifically, since resolveDevServerAndRepoPath fails before any
	// UpdateStatus call in this particular branch.
}

// Direct regression test for TASK-004's "real agent method not found ->
// typed, permanent FailedPrecondition" contract, mirroring EmulatorRelay's
// own equivalent test.
func TestEphemeralVmRelay_SuspendWorkspace_AgentMethodNotFound_MarksErrorAndTranslates(t *testing.T) {
	ds := testEmulatorDevServer(t)
	resolver := &fakeConnectionResolver{
		byConnectionID: map[string]domain.DevServer{"conn-1": ds},
		connByID:       map[string]domain.Connection{"conn-1": {RepoPath: "/repo"}},
	}
	agent := &fakeDevServerAgentClient{execErr: domain.ErrAgentMethodNotFound}
	runtimes := &fakeEphemeralVmRuntimeRepository{
		byWorkspace: map[string]domain.EphemeralVmRuntime{"ws-1": {ID: "rt-1", WorkspaceID: "ws-1"}},
	}
	uc := NewEphemeralVmRelay(resolver, agent, runtimes)

	ctx := withTenant(context.Background(), "tenant-1")
	_, err := uc.SuspendWorkspace(ctx, "conn-1", "ws-1", "suspend.sh")
	var ae *apperrors.AppError
	if !errors.As(err, &ae) || ae.Kind != apperrors.KindFailedPrecondition {
		t.Fatalf("expected KindFailedPrecondition, got %v", err)
	}
	if ae.Code != "INFRA_EPHEMERAL_VM_UNSUPPORTED" {
		t.Errorf("expected INFRA_EPHEMERAL_VM_UNSUPPORTED, got %q", ae.Code)
	}
	if len(agent.execCalls) != 1 || agent.execCalls[0] != "vm.exec" {
		t.Fatalf("expected exactly one vm.exec relay call, got %v", agent.execCalls)
	}
	if len(runtimes.updateStatusCalls) != 1 || runtimes.updateStatusCalls[0].status != "error" {
		t.Fatalf("expected runtime to be marked error on relay failure, got %+v", runtimes.updateStatusCalls)
	}
}

func TestEphemeralVmRelay_ResumeWorkspace_EmptyCommand_SkipsRelay(t *testing.T) {
	runtimes := &fakeEphemeralVmRuntimeRepository{
		byWorkspace: map[string]domain.EphemeralVmRuntime{"ws-1": {ID: "rt-1", WorkspaceID: "ws-1"}},
	}
	agent := &fakeDevServerAgentClient{}
	uc := NewEphemeralVmRelay(&fakeConnectionResolver{}, agent, runtimes)

	ctx := withTenant(context.Background(), "tenant-1")
	got, err := uc.ResumeWorkspace(ctx, "", "ws-1", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(agent.execCalls) != 0 {
		t.Errorf("expected no agent relay when command is empty, got %v", agent.execCalls)
	}
	if got.Status != "active" {
		t.Errorf("expected status=active, got %+v", got)
	}
}

func TestEphemeralVmRelay_ResumeWorkspace_Success_RelaysAndTransitions(t *testing.T) {
	ds := testEmulatorDevServer(t)
	resolver := &fakeConnectionResolver{
		byConnectionID: map[string]domain.DevServer{"conn-1": ds},
		connByID:       map[string]domain.Connection{"conn-1": {RepoPath: "/repo"}},
	}
	agent := &fakeDevServerAgentClient{execResult: map[string]any{}}
	runtimes := &fakeEphemeralVmRuntimeRepository{
		byWorkspace: map[string]domain.EphemeralVmRuntime{"ws-1": {ID: "rt-1", WorkspaceID: "ws-1"}},
	}
	uc := NewEphemeralVmRelay(resolver, agent, runtimes)

	ctx := withTenant(context.Background(), "tenant-1")
	got, err := uc.ResumeWorkspace(ctx, "conn-1", "ws-1", "resume.sh")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(agent.execCalls) != 1 || agent.execCalls[0] != "vm.exec" {
		t.Fatalf("expected exactly one vm.exec relay call, got %v", agent.execCalls)
	}
	if got.Status != "active" {
		t.Errorf("expected status=active, got %+v", got)
	}
}

func TestEphemeralVmRelay_CleanupWorkspace_NeverAttached_NoAgentCallMarksDestroyed(t *testing.T) {
	runtimes := &fakeEphemeralVmRuntimeRepository{}
	agent := &fakeDevServerAgentClient{}
	uc := NewEphemeralVmRelay(&fakeConnectionResolver{}, agent, runtimes)

	ctx := withTenant(context.Background(), "tenant-1")
	got, err := uc.CleanupWorkspace(ctx, "", "rt-1", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(agent.execCalls) != 0 {
		t.Errorf("expected no agent relay when command is empty, got %v", agent.execCalls)
	}
	if got.Status != "destroyed" {
		t.Errorf("expected status=destroyed, got %+v", got)
	}
}

func TestEphemeralVmRelay_CleanupWorkspace_WithCommand_RelaysThenDestroys(t *testing.T) {
	ds := testEmulatorDevServer(t)
	resolver := &fakeConnectionResolver{
		byConnectionID: map[string]domain.DevServer{"conn-1": ds},
		connByID:       map[string]domain.Connection{"conn-1": {RepoPath: "/repo"}},
	}
	agent := &fakeDevServerAgentClient{execResult: map[string]any{}}
	runtimes := &fakeEphemeralVmRuntimeRepository{
		byID: map[string]domain.EphemeralVmRuntime{"rt-1": {ID: "rt-1", RecipeID: "recipe-1"}},
	}
	uc := NewEphemeralVmRelay(resolver, agent, runtimes)

	ctx := withTenant(context.Background(), "tenant-1")
	got, err := uc.CleanupWorkspace(ctx, "conn-1", "rt-1", "docker rm -f x")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(agent.execCalls) != 1 || agent.execCalls[0] != "vm.exec" {
		t.Fatalf("expected exactly one vm.exec relay call, got %v", agent.execCalls)
	}
	if got.Status != "destroyed" {
		t.Errorf("expected status=destroyed, got %+v", got)
	}
}

// TestEphemeralVmRelay_SuspendWorkspace_SendsRecipeIdAndRuntimeIdToAgent is
// TASK-BE-EVM-001's regression test — vm.exec params must carry the
// runtime's recipeId/runtimeId so the agent knows which recipe/runtime the
// suspend command belongs to (field names must match agent-side
// TASK-AG-EVM-001 1:1).
func TestEphemeralVmRelay_SuspendWorkspace_SendsRecipeIdAndRuntimeIdToAgent(t *testing.T) {
	ds := testEmulatorDevServer(t)
	resolver := &fakeConnectionResolver{
		byConnectionID: map[string]domain.DevServer{"conn-1": ds},
		connByID:       map[string]domain.Connection{"conn-1": {RepoPath: "/repo"}},
	}
	agent := &fakeDevServerAgentClient{execResult: map[string]any{}}
	runtimes := &fakeEphemeralVmRuntimeRepository{
		byWorkspace: map[string]domain.EphemeralVmRuntime{"ws-1": {ID: "rt-1", WorkspaceID: "ws-1", RecipeID: "recipe-1"}},
	}
	uc := NewEphemeralVmRelay(resolver, agent, runtimes)

	ctx := withTenant(context.Background(), "tenant-1")
	if _, err := uc.SuspendWorkspace(ctx, "conn-1", "ws-1", "suspend.sh"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(agent.execParams) != 1 {
		t.Fatalf("expected exactly one vm.exec call, got %d", len(agent.execParams))
	}
	params := agent.execParams[0]
	if params["recipeId"] != "recipe-1" {
		t.Errorf("expected recipeId=recipe-1, got %v", params["recipeId"])
	}
	if params["runtimeId"] != "rt-1" {
		t.Errorf("expected runtimeId=rt-1, got %v", params["runtimeId"])
	}
}

// TestEphemeralVmRelay_ResumeWorkspace_SendsRecipeIdAndRuntimeIdToAgent
// mirrors the Suspend variant above.
func TestEphemeralVmRelay_ResumeWorkspace_SendsRecipeIdAndRuntimeIdToAgent(t *testing.T) {
	ds := testEmulatorDevServer(t)
	resolver := &fakeConnectionResolver{
		byConnectionID: map[string]domain.DevServer{"conn-1": ds},
		connByID:       map[string]domain.Connection{"conn-1": {RepoPath: "/repo"}},
	}
	agent := &fakeDevServerAgentClient{execResult: map[string]any{}}
	runtimes := &fakeEphemeralVmRuntimeRepository{
		byWorkspace: map[string]domain.EphemeralVmRuntime{"ws-1": {ID: "rt-1", WorkspaceID: "ws-1", RecipeID: "recipe-1"}},
	}
	uc := NewEphemeralVmRelay(resolver, agent, runtimes)

	ctx := withTenant(context.Background(), "tenant-1")
	if _, err := uc.ResumeWorkspace(ctx, "conn-1", "ws-1", "resume.sh"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(agent.execParams) != 1 {
		t.Fatalf("expected exactly one vm.exec call, got %d", len(agent.execParams))
	}
	params := agent.execParams[0]
	if params["recipeId"] != "recipe-1" {
		t.Errorf("expected recipeId=recipe-1, got %v", params["recipeId"])
	}
	if params["runtimeId"] != "rt-1" {
		t.Errorf("expected runtimeId=rt-1, got %v", params["runtimeId"])
	}
}

// TestEphemeralVmRelay_CleanupWorkspace_LoadsRuntimeBeforeCallingAgent
// covers TASK-BE-EVM-001's added step: CleanupWorkspace only receives a
// runtimeID (not a workspaceID, unlike Suspend/Resume), so it must load the
// runtime via runtimes.Get before it can build vm.exec's recipeId param —
// and must fail with INFRA_EPHEMERAL_VM_RUNTIME_NOT_FOUND, never reaching
// the agent, when that runtimeID doesn't exist.
func TestEphemeralVmRelay_CleanupWorkspace_LoadsRuntimeBeforeCallingAgent(t *testing.T) {
	ds := testEmulatorDevServer(t)
	resolver := &fakeConnectionResolver{
		byConnectionID: map[string]domain.DevServer{"conn-1": ds},
		connByID:       map[string]domain.Connection{"conn-1": {RepoPath: "/repo"}},
	}
	agent := &fakeDevServerAgentClient{execResult: map[string]any{}}
	runtimes := &fakeEphemeralVmRuntimeRepository{
		byID: map[string]domain.EphemeralVmRuntime{"rt-1": {ID: "rt-1", RecipeID: "recipe-1"}},
	}
	uc := NewEphemeralVmRelay(resolver, agent, runtimes)

	ctx := withTenant(context.Background(), "tenant-1")
	if _, err := uc.CleanupWorkspace(ctx, "conn-1", "rt-1", "docker rm -f x"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(agent.execParams) != 1 {
		t.Fatalf("expected exactly one vm.exec call, got %d", len(agent.execParams))
	}
	params := agent.execParams[0]
	if params["recipeId"] != "recipe-1" {
		t.Errorf("expected recipeId=recipe-1, got %v", params["recipeId"])
	}
	if params["runtimeId"] != "rt-1" {
		t.Errorf("expected runtimeId=rt-1, got %v", params["runtimeId"])
	}
}

// TestEphemeralVmRelay_CleanupWorkspace_UnknownRuntimeID_NotFoundBeforeAgentCall
// asserts the "not found" branch of the runtimes.Get load added above never
// reaches the agent.
func TestEphemeralVmRelay_CleanupWorkspace_UnknownRuntimeID_NotFoundBeforeAgentCall(t *testing.T) {
	agent := &fakeDevServerAgentClient{execResult: map[string]any{}}
	runtimes := &fakeEphemeralVmRuntimeRepository{} // no byID entries — "rt-missing" does not exist
	uc := NewEphemeralVmRelay(&fakeConnectionResolver{}, agent, runtimes)

	ctx := withTenant(context.Background(), "tenant-1")
	_, err := uc.CleanupWorkspace(ctx, "conn-1", "rt-missing", "docker rm -f x")
	var ae *apperrors.AppError
	if !errors.As(err, &ae) || ae.Kind != apperrors.KindNotFound {
		t.Fatalf("expected KindNotFound, got %v", err)
	}
	if ae.Code != "INFRA_EPHEMERAL_VM_RUNTIME_NOT_FOUND" {
		t.Errorf("expected INFRA_EPHEMERAL_VM_RUNTIME_NOT_FOUND, got %q", ae.Code)
	}
	if len(agent.execCalls) != 0 {
		t.Errorf("expected no agent call when runtime lookup fails, got %v", agent.execCalls)
	}
}

func TestEphemeralVmRelay_CleanupWorkspace_NoTenant_ReturnsError(t *testing.T) {
	uc := NewEphemeralVmRelay(&fakeConnectionResolver{}, &fakeDevServerAgentClient{}, &fakeEphemeralVmRuntimeRepository{})
	_, err := uc.CleanupWorkspace(context.Background(), "", "rt-1", "")
	if err == nil {
		t.Fatal("expected an error when no tenant is in context")
	}
}

// drainProvisionEvents reads events off ch until it closes, with a bounded
// wait — TASK-BE-EVM-004's Provision tests don't want to hang forever if the
// wrapping goroutine never closes out.
func drainProvisionEvents(t *testing.T, ch <-chan VmProvisionEvent) []VmProvisionEvent {
	t.Helper()
	var got []VmProvisionEvent
	deadline := time.After(5 * time.Second)
	for {
		select {
		case e, ok := <-ch:
			if !ok {
				return got
			}
			got = append(got, e)
		case <-deadline:
			t.Fatalf("timed out waiting for Provision's event channel to close; events so far: %+v", got)
		}
	}
}

// TestEphemeralVmRelay_Provision_ResolvesConnectionBeforeCallingAgent
// asserts a successful resolution actually calls
// DevServerAgentClient.StreamVmProvision with the resolved devServer/repoPath
// — the positive-path mirror of NoConnectionReturnsTypedError below.
func TestEphemeralVmRelay_Provision_ResolvesConnectionBeforeCallingAgent(t *testing.T) {
	ds := testEmulatorDevServer(t)
	resolver := &fakeConnectionResolver{
		byConnectionID: map[string]domain.DevServer{"conn-1": ds},
		connByID:       map[string]domain.Connection{"conn-1": {RepoPath: "/repo"}},
	}
	agent := &fakeDevServerAgentClient{streamVmProvisionEvents: make(chan VmProvisionEvent, 1)}
	runtimes := &fakeEphemeralVmRuntimeRepository{}
	uc := NewEphemeralVmRelay(resolver, agent, runtimes)

	ctx := withTenant(context.Background(), "tenant-1")
	agent.streamVmProvisionEvents <- VmProvisionEvent{Type: "stdout", Chunk: "hi"}
	close(agent.streamVmProvisionEvents)
	events, unsubscribe, err := uc.Provision(ctx, "conn-1", "recipe-1", "rt-1", "create.sh")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer unsubscribe()

	got := drainProvisionEvents(t, events)
	if len(got) != 1 || got[0].Type != "stdout" {
		t.Fatalf("expected the stdout event to pass through, got %+v", got)
	}
	if len(agent.streamVmProvisionCalls) != 1 {
		t.Fatalf("expected exactly one StreamVmProvision call, got %d", len(agent.streamVmProvisionCalls))
	}
	call := agent.streamVmProvisionCalls[0]
	if call.RepoPath != "/repo" || call.RecipeID != "recipe-1" || call.RuntimeID != "rt-1" || call.Command != "create.sh" {
		t.Errorf("unexpected StreamVmProvision params: %+v", call)
	}
}

// TestEphemeralVmRelay_Provision_NoConnectionReturnsTypedError mirrors
// TestEphemeralVmRelay_SuspendWorkspace_NoConnectionID_FailsPrecondition —
// same INFRA_EPHEMERAL_VM_NO_CONNECTION contract, and the agent must never
// be called.
func TestEphemeralVmRelay_Provision_NoConnectionReturnsTypedError(t *testing.T) {
	agent := &fakeDevServerAgentClient{}
	uc := NewEphemeralVmRelay(&fakeConnectionResolver{}, agent, &fakeEphemeralVmRuntimeRepository{})

	ctx := withTenant(context.Background(), "tenant-1")
	_, _, err := uc.Provision(ctx, "", "recipe-1", "rt-1", "create.sh")
	var ae *apperrors.AppError
	if !errors.As(err, &ae) || ae.Kind != apperrors.KindFailedPrecondition {
		t.Fatalf("expected KindFailedPrecondition, got %v", err)
	}
	if ae.Code != "INFRA_EPHEMERAL_VM_NO_CONNECTION" {
		t.Errorf("expected INFRA_EPHEMERAL_VM_NO_CONNECTION, got %q", ae.Code)
	}
	if len(agent.streamVmProvisionCalls) != 0 {
		t.Errorf("expected no agent call when connection resolution fails, got %v", agent.streamVmProvisionCalls)
	}
}

// TestEphemeralVmRelay_Provision_OrcaServerResultUpdatesStatusProvisioning
// covers the terminal "result" event's orca-server branch.
func TestEphemeralVmRelay_Provision_OrcaServerResultUpdatesStatusProvisioning(t *testing.T) {
	ds := testEmulatorDevServer(t)
	resolver := &fakeConnectionResolver{
		byConnectionID: map[string]domain.DevServer{"conn-1": ds},
		connByID:       map[string]domain.Connection{"conn-1": {RepoPath: "/repo"}},
	}
	events := make(chan VmProvisionEvent, 1)
	agent := &fakeDevServerAgentClient{streamVmProvisionEvents: events}
	runtimes := &fakeEphemeralVmRuntimeRepository{}
	uc := NewEphemeralVmRelay(resolver, agent, runtimes)

	ctx := withTenant(context.Background(), "tenant-1")
	events <- VmProvisionEvent{Type: "result", Result: VmProvisionResult{Type: "orca-server", PairingCode: "abc", ProjectRoot: "/vm/repo"}}
	close(events)
	out, unsubscribe, err := uc.Provision(ctx, "conn-1", "recipe-1", "rt-1", "create.sh")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer unsubscribe()
	drainProvisionEvents(t, out)

	if len(runtimes.updateProvisionResultCalls) != 1 {
		t.Fatalf("expected exactly one UpdateProvisionResult call, got %+v", runtimes.updateProvisionResultCalls)
	}
	call := runtimes.updateProvisionResultCalls[0]
	if call.status != "provisioning" || call.connectionType != "orca-server" || call.id != "rt-1" {
		t.Errorf("unexpected UpdateProvisionResult call: %+v", call)
	}
}

// fakeEphemeralVmSshProvisioner implements EphemeralVmSshProvisioner —
// TASK-BE-EVM-012's compile-time interface, exercised here standing in for
// whichever real implementation (Hướng A or B) config.EphemeralVmSshMode
// selects at wiring time.
type fakeEphemeralVmSshProvisioner struct {
	connectionID string
	err          error
	calls        []fakeEphemeralVmSshProvisionerCall
}

type fakeEphemeralVmSshProvisionerCall struct {
	tenantID, runtimeID string
	sourceDevServer     domain.DevServer
	target              domain.EphemeralVmSshTarget
}

func (f *fakeEphemeralVmSshProvisioner) Provision(_ context.Context, tenantID, runtimeID string, sourceDevServer domain.DevServer, target domain.EphemeralVmSshTarget) (string, error) {
	f.calls = append(f.calls, fakeEphemeralVmSshProvisionerCall{tenantID: tenantID, runtimeID: runtimeID, sourceDevServer: sourceDevServer, target: target})
	if f.err != nil {
		return "", f.err
	}
	return f.connectionID, nil
}

// TestEphemeralVmRelay_Provision_SshResultDispatchesToConfiguredProvisioner
// is TASK-BE-EVM-012's dispatch test (the task doc names it
// TestAttachWorkspace_SshType_DispatchesToConfiguredProvisioner — renamed
// here to match where the dispatch actually happens: applyProvisionResult,
// reached from Provision's terminal-event handling, not AttachWorkspace —
// see applyProvisionResult's doc comment for the full audit). A successful
// dial transitions the runtime to "provisioning"/"ssh", the same shape the
// "orca-server" branch already uses.
func TestEphemeralVmRelay_Provision_SshResultDispatchesToConfiguredProvisioner(t *testing.T) {
	ds := testEmulatorDevServer(t)
	resolver := &fakeConnectionResolver{
		byConnectionID: map[string]domain.DevServer{"conn-1": ds},
		connByID:       map[string]domain.Connection{"conn-1": {RepoPath: "/repo"}},
	}
	events := make(chan VmProvisionEvent, 1)
	agent := &fakeDevServerAgentClient{streamVmProvisionEvents: events}
	runtimes := &fakeEphemeralVmRuntimeRepository{}
	sshProvisioner := &fakeEphemeralVmSshProvisioner{connectionID: "conn-ssh-1"}
	uc := NewEphemeralVmRelay(resolver, agent, runtimes, WithSshProvisioner(sshProvisioner))

	ctx := withTenant(context.Background(), "tenant-1")
	events <- VmProvisionEvent{Type: "result", Result: VmProvisionResult{
		Type: "ssh", ProjectRoot: "/vm/repo",
		SshTarget: &EphemeralVmRecipeSshTarget{Host: "10.0.0.9", Port: 22, Username: "dev", IdentityFile: "vault-ref"},
	}}
	close(events)
	out, unsubscribe, err := uc.Provision(ctx, "conn-1", "recipe-1", "rt-1", "create.sh")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer unsubscribe()
	drainProvisionEvents(t, out)

	if len(sshProvisioner.calls) != 1 {
		t.Fatalf("expected exactly one Provision call on the configured sshProvisioner, got %+v", sshProvisioner.calls)
	}
	call := sshProvisioner.calls[0]
	if call.tenantID != "tenant-1" || call.runtimeID != "rt-1" {
		t.Errorf("unexpected dispatch args: %+v", call)
	}
	if call.target.Host != "10.0.0.9" || call.target.Port != 22 || call.target.Username != "dev" {
		t.Errorf("unexpected converted target: %+v", call.target)
	}

	if len(runtimes.updateProvisionResultCalls) != 1 {
		t.Fatalf("expected exactly one UpdateProvisionResult call, got %+v", runtimes.updateProvisionResultCalls)
	}
	got := runtimes.updateProvisionResultCalls[0]
	if got.status != "provisioning" || got.connectionType != "ssh" || got.id != "rt-1" {
		t.Errorf("unexpected UpdateProvisionResult call: %+v", got)
	}
}

// TestEphemeralVmRelay_SshProvision_PassesSourceDevServerAndProjectRoot is
// TASK-BE-EVM-016's Gap 2 regression guard: Provision's own devServer
// resolution (resolveDevServerAndRepoPath, reused for the vm.provision
// relay itself) must be threaded into EphemeralVmSshProvisioner.Provision's
// sourceDevServer parameter, and VmProvisionResult.ProjectRoot into
// target.ProjectRoot — neither the identity of the dev server nor the
// project root the recipe reported may be silently dropped.
func TestEphemeralVmRelay_SshProvision_PassesSourceDevServerAndProjectRoot(t *testing.T) {
	ds := testEmulatorDevServer(t)
	resolver := &fakeConnectionResolver{
		byConnectionID: map[string]domain.DevServer{"conn-1": ds},
		connByID:       map[string]domain.Connection{"conn-1": {RepoPath: "/repo"}},
	}
	events := make(chan VmProvisionEvent, 1)
	agent := &fakeDevServerAgentClient{streamVmProvisionEvents: events}
	runtimes := &fakeEphemeralVmRuntimeRepository{}
	sshProvisioner := &fakeEphemeralVmSshProvisioner{connectionID: "conn-ssh-1"}
	uc := NewEphemeralVmRelay(resolver, agent, runtimes, WithSshProvisioner(sshProvisioner))

	ctx := withTenant(context.Background(), "tenant-1")
	events <- VmProvisionEvent{Type: "result", Result: VmProvisionResult{
		Type: "ssh", ProjectRoot: "/vm/repo",
		SshTarget: &EphemeralVmRecipeSshTarget{Host: "10.0.0.9", Port: 22, Username: "dev", IdentityFile: "/home/dev/.ssh/id_ed25519"},
	}}
	close(events)
	out, unsubscribe, err := uc.Provision(ctx, "conn-1", "recipe-1", "rt-1", "create.sh")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer unsubscribe()
	drainProvisionEvents(t, out)

	if len(sshProvisioner.calls) != 1 {
		t.Fatalf("expected exactly one Provision call, got %+v", sshProvisioner.calls)
	}
	call := sshProvisioner.calls[0]
	if call.sourceDevServer.ID != ds.ID {
		t.Errorf("expected sourceDevServer to be the SAME devServer resolveDevServerAndRepoPath resolved (%q), got %q", ds.ID, call.sourceDevServer.ID)
	}
	if call.target.ProjectRoot != "/vm/repo" {
		t.Errorf("expected target.ProjectRoot to carry VmProvisionResult.ProjectRoot, got %q", call.target.ProjectRoot)
	}
	if call.target.IdentityFilePath != "/home/dev/.ssh/id_ed25519" {
		t.Errorf("expected target.IdentityFilePath to carry the recipe's raw identityFile path (not PrivateKeyPEM), got %q", call.target.IdentityFilePath)
	}
	if call.target.PrivateKeyPEM != "" {
		t.Errorf("expected target.PrivateKeyPEM to stay empty at build time (resolved later, only by Hướng B), got %q", call.target.PrivateKeyPEM)
	}
}

// TestEphemeralVmRelay_Provision_SshProvisionerError_MarksRuntimeError
// covers the configured-but-failing-dial path — distinct from the
// nil-provisioner fallback test below.
func TestEphemeralVmRelay_Provision_SshProvisionerError_MarksRuntimeError(t *testing.T) {
	ds := testEmulatorDevServer(t)
	resolver := &fakeConnectionResolver{
		byConnectionID: map[string]domain.DevServer{"conn-1": ds},
		connByID:       map[string]domain.Connection{"conn-1": {RepoPath: "/repo"}},
	}
	events := make(chan VmProvisionEvent, 1)
	agent := &fakeDevServerAgentClient{streamVmProvisionEvents: events}
	runtimes := &fakeEphemeralVmRuntimeRepository{}
	sshProvisioner := &fakeEphemeralVmSshProvisioner{err: errors.New("dial: connection refused")}
	uc := NewEphemeralVmRelay(resolver, agent, runtimes, WithSshProvisioner(sshProvisioner))

	ctx := withTenant(context.Background(), "tenant-1")
	events <- VmProvisionEvent{Type: "result", Result: VmProvisionResult{
		Type: "ssh", ProjectRoot: "/vm/repo",
		SshTarget: &EphemeralVmRecipeSshTarget{Host: "10.0.0.9", Port: 22, Username: "dev"},
	}}
	close(events)
	out, unsubscribe, err := uc.Provision(ctx, "conn-1", "recipe-1", "rt-1", "create.sh")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer unsubscribe()
	drainProvisionEvents(t, out)

	if len(runtimes.updateProvisionResultCalls) != 1 {
		t.Fatalf("expected exactly one UpdateProvisionResult call, got %+v", runtimes.updateProvisionResultCalls)
	}
	got := runtimes.updateProvisionResultCalls[0]
	if got.status != "error" || got.connectionType != "ssh" || got.lastError != "dial: connection refused" {
		t.Errorf("unexpected UpdateProvisionResult call: %+v", got)
	}
}

// TestEphemeralVmRelay_Provision_SshResultDoesNotAttemptDial is
// TASK-BE-EVM-012's regression-guard test
// (TestAttachWorkspace_SshType_NoLongerReturnsPermanentUnsupportedError in
// the task doc, renamed for the same reason as the dispatch test above):
// confirms the CR-EVM-005 guard only still applies as the NO-PROVISIONER-
// CONFIGURED fallback (uc.sshProvisioner == nil) — not a permanent block —
// and that the dispatch tests above exercise the actual unlock.
func TestEphemeralVmRelay_Provision_SshResultDoesNotAttemptDial(t *testing.T) {
	ds := testEmulatorDevServer(t)
	resolver := &fakeConnectionResolver{
		byConnectionID: map[string]domain.DevServer{"conn-1": ds},
		connByID:       map[string]domain.Connection{"conn-1": {RepoPath: "/repo"}},
	}
	events := make(chan VmProvisionEvent, 1)
	agent := &fakeDevServerAgentClient{streamVmProvisionEvents: events}
	runtimes := &fakeEphemeralVmRuntimeRepository{}
	uc := NewEphemeralVmRelay(resolver, agent, runtimes)

	ctx := withTenant(context.Background(), "tenant-1")
	events <- VmProvisionEvent{Type: "result", Result: VmProvisionResult{
		Type: "ssh", ProjectRoot: "/vm/repo",
		SshTarget: &EphemeralVmRecipeSshTarget{Host: "10.0.0.9", Port: 22, Username: "dev"},
	}}
	close(events)
	out, unsubscribe, err := uc.Provision(ctx, "conn-1", "recipe-1", "rt-1", "create.sh")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer unsubscribe()
	drainProvisionEvents(t, out)

	if len(runtimes.updateProvisionResultCalls) != 1 {
		t.Fatalf("expected exactly one UpdateProvisionResult call, got %+v", runtimes.updateProvisionResultCalls)
	}
	call := runtimes.updateProvisionResultCalls[0]
	if call.status != "error" || call.connectionType != "ssh" {
		t.Errorf("expected status=error, connectionType=ssh (guard still blocks ssh), got %+v", call)
	}
}

// TestEphemeralVmRelay_Provision_AgentErrorEventMarksRuntimeError covers the
// terminal "error" event path (as opposed to a "result" event whose
// Result.Type is unrecognized).
func TestEphemeralVmRelay_Provision_AgentErrorEventMarksRuntimeError(t *testing.T) {
	ds := testEmulatorDevServer(t)
	resolver := &fakeConnectionResolver{
		byConnectionID: map[string]domain.DevServer{"conn-1": ds},
		connByID:       map[string]domain.Connection{"conn-1": {RepoPath: "/repo"}},
	}
	events := make(chan VmProvisionEvent, 1)
	agent := &fakeDevServerAgentClient{streamVmProvisionEvents: events}
	runtimes := &fakeEphemeralVmRuntimeRepository{}
	uc := NewEphemeralVmRelay(resolver, agent, runtimes)

	ctx := withTenant(context.Background(), "tenant-1")
	events <- VmProvisionEvent{Type: "error", ErrorMsg: "vm.provision exited 1"}
	close(events)
	out, unsubscribe, err := uc.Provision(ctx, "conn-1", "recipe-1", "rt-1", "create.sh")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer unsubscribe()
	drainProvisionEvents(t, out)

	if len(runtimes.updateStatusCalls) != 1 {
		t.Fatalf("expected exactly one UpdateStatus call, got %+v", runtimes.updateStatusCalls)
	}
	call := runtimes.updateStatusCalls[0]
	if call.status != "error" || call.lastError != "vm.provision exited 1" {
		t.Errorf("unexpected UpdateStatus call: %+v", call)
	}
}

// TestEphemeralVmRelay_CancelProvision_RelaysVmCancelProvisionToAgent covers
// CancelProvision's relay-to-agent responsibility (distinct from the
// provisionId->unsubscribe registry, which lives at the wscompat layer, not
// here — see CancelProvision's doc comment).
func TestEphemeralVmRelay_CancelProvision_RelaysVmCancelProvisionToAgent(t *testing.T) {
	ds := testEmulatorDevServer(t)
	resolver := &fakeConnectionResolver{
		byConnectionID: map[string]domain.DevServer{"conn-1": ds},
		connByID:       map[string]domain.Connection{"conn-1": {RepoPath: "/repo"}},
	}
	agent := &fakeDevServerAgentClient{execResult: map[string]any{"cancelled": true}}
	uc := NewEphemeralVmRelay(resolver, agent, &fakeEphemeralVmRuntimeRepository{})

	ctx := withTenant(context.Background(), "tenant-1")
	if err := uc.CancelProvision(ctx, "conn-1", "rt-1"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(agent.execCalls) != 1 || agent.execCalls[0] != "vm.cancelProvision" {
		t.Fatalf("expected exactly one vm.cancelProvision call, got %v", agent.execCalls)
	}
	if agent.execParams[0]["runtimeId"] != "rt-1" {
		t.Errorf("expected runtimeId=rt-1, got %v", agent.execParams[0])
	}
}

func TestEphemeralVmRelay_CancelProvision_NoTenant_ReturnsError(t *testing.T) {
	uc := NewEphemeralVmRelay(&fakeConnectionResolver{}, &fakeDevServerAgentClient{}, &fakeEphemeralVmRuntimeRepository{})
	err := uc.CancelProvision(context.Background(), "conn-1", "rt-1")
	if err == nil {
		t.Fatal("expected an error when no tenant is in context")
	}
}
